import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestGovernor, GovernorRejection, GovernorTimeout, isTransportError } from '../request-governor.js';

/** A call Home Assistant accepts and never answers. */
const neverResolves = () => new Promise(() => {});

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** A task that resolves after `ms`, recording peak concurrency in `probe`. */
function tracked(probe, ms = 5, value = 'ok') {
    return async () => {
        probe.active++;
        probe.peak = Math.max(probe.peak, probe.active);
        await tick(ms);
        probe.active--;
        return value;
    };
}

const connLost = () => Object.assign(new Error('Connection lost'), { code: 3 });
const validationError = () => Object.assign(new Error('Validation error: Too many uris requested'),
    { code: 'service_validation_error' });

const settle = (p) => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));

test('caps concurrency at maxConcurrent', async () => {
    // maxQueue is raised past the burst size so this exercises concurrency
    // alone; overflow shedding has its own test below.
    const g = new RequestGovernor({ maxConcurrent: 3, maxQueue: 50 });
    const probe = { active: 0, peak: 0 };
    const results = await Promise.all(
        Array.from({ length: 30 }, () => g.run(tracked(probe), { label: 'get_track' }))
    );
    assert.equal(results.length, 30);
    assert.ok(results.every(r => r === 'ok'));
    assert.equal(probe.peak, 3, `peak concurrency was ${probe.peak}, expected 3`);
    g.destroy();
});

test('sheds oldest background work when the queue overflows', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1, maxQueue: 5 });
    const probe = { active: 0, peak: 0 };
    const settled = await Promise.all(
        Array.from({ length: 20 }, () => settle(g.run(tracked(probe, 2))))
    );
    const shed = settled.filter(r => !r.ok);
    assert.ok(shed.length > 0, 'expected some calls to be shed');
    assert.ok(shed.every(r => r.e instanceof GovernorRejection && r.e.reason === 'queue-full'));
    // The queue never grew past the cap, so the survivors are bounded too.
    assert.ok(settled.filter(r => r.ok).length <= 1 + 5 + 1);
    g.destroy();
});

test('user work jumps ahead of queued background work', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1 });
    const order = [];
    const mark = (name) => async () => { await tick(2); order.push(name); };

    const first = g.run(mark('bg-running'));           // occupies the single slot
    await tick(0);
    const bg = g.run(mark('bg-queued'));
    const user = g.run(mark('user'), { priority: 'user' });

    await Promise.all([first, bg, user]);
    assert.deepEqual(order, ['bg-running', 'user', 'bg-queued']);
    g.destroy();
});

test('breaker opens after repeated failures and fails background work fast', async () => {
    const events = [];
    const g = new RequestGovernor({
        maxConcurrent: 1, failureThreshold: 3, openMs: 10_000,
        onStateChange: (s) => events.push(s.state),
    });

    for (let i = 0; i < 3; i++) {
        const r = await settle(g.run(async () => { throw connLost(); }));
        assert.equal(r.ok, false);
    }

    assert.ok(g.isOpen, 'breaker should be open');
    assert.ok(events.includes('open'));

    // Background work is now refused without touching the transport at all.
    let attempts = 0;
    const r = await settle(g.run(async () => { attempts++; return 'nope'; }));
    assert.equal(r.ok, false);
    assert.equal(r.e.reason, 'circuit-open');
    assert.equal(attempts, 0, 'open breaker must not execute the task');
    g.destroy();
});

test('a queued burst is abandoned, not replayed, when the breaker trips', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1, maxQueue: 50, failureThreshold: 2 });
    let executed = 0;
    const failing = async () => { executed++; throw connLost(); };

    // One burst, exactly like a playlist pager fanning out.
    const all = await Promise.all(
        Array.from({ length: 40 }, () => settle(g.run(failing)))
    );

    assert.ok(all.every(r => !r.ok));
    // Threshold is 2, so at most a couple of real calls go out; the rest of the
    // burst is dropped rather than queued up to hammer a dead socket.
    assert.ok(executed <= 3, `executed ${executed} calls, expected the burst to be abandoned`);
    g.destroy();
});

test('user action probes an open breaker and closes it on success', async () => {
    const g = new RequestGovernor({ maxConcurrent: 2, failureThreshold: 2, openMs: 10_000 });
    for (let i = 0; i < 2; i++) await settle(g.run(async () => { throw connLost(); }));
    assert.ok(g.isOpen);

    const r = await settle(g.run(async () => 'played', { priority: 'user', label: 'play_context' }));
    assert.equal(r.ok, true, 'user action should be allowed to probe');
    assert.equal(r.v, 'played');
    assert.equal(g.isOpen, false, 'a successful probe should close the breaker');

    // Background work flows again.
    const bg = await settle(g.run(async () => 'read'));
    assert.equal(bg.ok, true);
    g.destroy();
});

test('a failed probe re-opens immediately with a longer backoff', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1, failureThreshold: 2, openMs: 50, maxOpenMs: 10_000 });
    for (let i = 0; i < 2; i++) await settle(g.run(async () => { throw connLost(); }));
    const firstWindow = g.stats.openFor;

    await tick(70); // let the first window elapse
    const probe = await settle(g.run(async () => { throw connLost(); }, { priority: 'user' }));
    assert.equal(probe.ok, false);
    assert.ok(g.isOpen, 'a failed probe must re-open the breaker');
    assert.ok(g.stats.openFor > firstWindow, 'backoff should grow after a failed probe');
    g.destroy();
});

test('holds work while canSend is false, releases it on reconnect', async () => {
    let up = false;
    const g = new RequestGovernor({ maxConcurrent: 2, canSend: () => up });
    let executed = 0;

    const pending = settle(g.run(async () => { executed++; return 'ok'; }, { priority: 'user' }));
    await tick(60);
    assert.equal(executed, 0, 'nothing should be sent while the socket is down');

    up = true;
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(executed, 1);
    g.destroy();
});

test('stale background work is dropped rather than sent late', async () => {
    let up = false;
    const g = new RequestGovernor({ maxConcurrent: 2, canSend: () => up, maxWaitMs: 40 });
    let executed = 0;

    const r = await settle(g.run(async () => { executed++; }, { label: 'get_track' }));
    assert.equal(r.ok, false);
    assert.equal(r.e.reason, 'stale');
    assert.equal(executed, 0);
    g.destroy();
});

test('validation errors also trip the breaker (a flood is a flood)', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1, failureThreshold: 3 });
    for (let i = 0; i < 3; i++) await settle(g.run(async () => { throw validationError(); }));
    assert.ok(g.isOpen);
    g.destroy();
});

test('isTransportError distinguishes socket failures from Spotify rejections', () => {
    assert.equal(isTransportError(connLost()), true);
    assert.equal(isTransportError(new Error('Websocket died, forcing reconnect')), true);
    assert.equal(isTransportError(validationError()), false);
    assert.equal(isTransportError(null), false);
});

test('a call that never answers releases its slot on timeout', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1, callTimeoutMs: 40 });

    const hung = settle(g.run(neverResolves, { label: 'get_album' }));
    const behind = settle(g.run(async () => 'ok', { label: 'get_track' }));

    const [a, b] = await Promise.all([hung, behind]);
    assert.equal(a.ok, false);
    assert.ok(a.e instanceof GovernorTimeout, 'the hung call should time out');
    assert.equal(b.ok, true, 'work behind it must still run');
    assert.equal(b.v, 'ok');
    g.destroy();
});

test('hung calls cannot permanently exhaust every slot', async () => {
    // Reproduces the observed failure: {active: 3, queued: 1} with nothing
    // failing, because three unanswered calls held all three slots forever.
    const g = new RequestGovernor({ maxConcurrent: 3, callTimeoutMs: 40, maxWaitMs: 5000 });

    const hung = [
        settle(g.run(neverResolves, { label: 'a' })),
        settle(g.run(neverResolves, { label: 'b' })),
        settle(g.run(neverResolves, { label: 'c' })),
    ];
    await tick(5);
    assert.equal(g.stats.active, 3, 'all slots taken');

    const later = await settle(g.run(async () => 'recovered', { label: 'get_album' }));
    assert.equal(later.ok, true, 'the pipeline must recover once budgets expire');
    assert.equal(later.v, 'recovered');

    await Promise.all(hung);
    assert.equal(g.stats.active, 0);
    g.destroy();
});

test('user actions get a longer budget than background reads', async () => {
    const g = new RequestGovernor({ maxConcurrent: 2, callTimeoutMs: 30, userCallTimeoutMs: 5000 });

    const bg = settle(g.run(neverResolves, { label: 'get_track' }));
    const user = settle(g.run(async () => { await tick(120); return 'played'; },
        { priority: 'user', label: 'play_context' }));

    assert.equal((await bg).ok, false, 'background read gives up quickly');
    assert.equal((await user).ok, true, 'a slow user action is not cut off');
    g.destroy();
});

test('stats name the in-flight and queued calls', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1, callTimeoutMs: 200 });
    const running = settle(g.run(neverResolves, { label: 'get_album' }));
    const queued = settle(g.run(async () => 'ok', { label: 'check_album_favorites' }));

    await tick(10);
    const s = g.stats;
    assert.match(s.activeLabels[0], /^get_album \(\d+ms\)$/);
    assert.deepEqual(s.queuedLabels, ['check_album_favorites']);

    await Promise.all([running, queued]);
    g.destroy();
});

test('repeated timeouts eventually trip the breaker', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1, callTimeoutMs: 60, failureThreshold: 3 });
    for (let i = 0; i < 3; i++) await settle(g.run(neverResolves, { label: 'get_album' }));
    assert.equal(g.isOpen, true, 'a service that never answers should back off');
    g.destroy();
});

test('repeated timeouts are diagnosed as a stalled backend, not a flaky one', async () => {
    const events = [];
    const g = new RequestGovernor({
        maxConcurrent: 1, callTimeoutMs: 60, failureThreshold: 3,
        stalledThreshold: 3, openMs: 15_000, maxOpenMs: 120_000, stalledOpenMs: 900_000,
        onStateChange: (s) => events.push(s),
    });

    for (let i = 0; i < 3; i++) await settle(g.run(neverResolves, { label: 'get_track' }));

    const open = events.find(e => e.state === 'open');
    assert.equal(open.stalled, true, 'unanswered calls should read as stalled');
    assert.equal(g.stats.stalled, true);
    // A quota window is hours; the ordinary ceiling would retry every 2 minutes.
    assert.ok(open.openFor >= 900_000, `backed off only ${open.openFor}ms`);
    g.destroy();
});

test('ordinary errors keep the short backoff', async () => {
    const events = [];
    const g = new RequestGovernor({
        maxConcurrent: 1, failureThreshold: 3, stalledThreshold: 3,
        openMs: 15_000, maxOpenMs: 120_000, stalledOpenMs: 900_000,
        onStateChange: (s) => events.push(s),
    });

    for (let i = 0; i < 3; i++) await settle(g.run(async () => { throw connLost(); }));

    const open = events.find(e => e.state === 'open');
    assert.equal(open.stalled, false, 'errors are not the stalled signature');
    assert.ok(open.openFor <= 120_000, 'should use the ordinary ceiling');
    g.destroy();
});

test('a success clears the stalled diagnosis', async () => {
    const g = new RequestGovernor({
        maxConcurrent: 1, callTimeoutMs: 60, failureThreshold: 2, stalledThreshold: 2,
        stalledOpenMs: 900_000,
    });
    for (let i = 0; i < 2; i++) await settle(g.run(neverResolves));
    assert.equal(g.stats.stalled, true);

    // A user action probes the open breaker and succeeds.
    const r = await settle(g.run(async () => 'ok', { priority: 'user' }));
    assert.equal(r.ok, true);
    assert.equal(g.stats.stalled, false);
    assert.equal(g.isOpen, false);
    g.destroy();
});

test('resume() clears a long stall on user request', async () => {
    const g = new RequestGovernor({
        maxConcurrent: 1, callTimeoutMs: 60, failureThreshold: 2, stalledThreshold: 2,
        stalledOpenMs: 900_000,
    });
    for (let i = 0; i < 2; i++) await settle(g.run(neverResolves));
    assert.equal(g.isOpen, true);

    g.resume();

    assert.equal(g.isOpen, false, 'user retry should not wait out a 15-minute backoff');
    assert.equal(g.stats.stalled, false);
    const r = await settle(g.run(async () => 'ok'));
    assert.equal(r.ok, true, 'background work flows again after resume');
    g.destroy();
});

test('destroy rejects queued work and stops accepting more', async () => {
    const g = new RequestGovernor({ maxConcurrent: 1 });
    const probe = { active: 0, peak: 0 };
    const queued = settle(g.run(tracked(probe, 30)));
    const alsoQueued = settle(g.run(tracked(probe, 30)));
    g.destroy();

    const after = await settle(g.run(async () => 'nope'));
    assert.equal(after.ok, false);
    assert.equal(after.e.reason, 'destroyed');
    assert.equal((await alsoQueued).ok, false);
    await queued; // the already-dispatched one is allowed to finish
});
