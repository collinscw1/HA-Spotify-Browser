/*
 * Every SpotifyPlus call this card makes rides the same Home Assistant
 * WebSocket that the rest of the frontend uses for state updates. Unbounded
 * fan-out — a playlist pager re-checking favourites once per appended page,
 * per-track artwork enrichment, parallel library hydration — can saturate that
 * socket badly enough to take down navigation for the whole HA session, not
 * just this card. Once the socket drops, every in-flight call rejects, the
 * views swallow the errors, and the next render starts the cycle again.
 *
 * The governor is the single place that decides whether a call may go out:
 *   - a semaphore caps how many run concurrently;
 *   - a bounded queue sheds the oldest background work instead of growing;
 *   - a circuit breaker trips after repeated failures and fails fast, backing
 *     off exponentially, so a dead socket is never hammered;
 *   - a caller-supplied `canSend` gate holds work while the socket is down;
 *   - user-initiated calls jump the queue and may probe an open breaker, so
 *     pressing play still works the moment the connection comes back.
 *
 * Nothing here is Spotify- or HA-specific: `run` just wraps an async thunk.
 */

/** Thrown (and caught by SpotifyApi) when a call is refused rather than attempted. */
export class GovernorRejection extends Error {
    constructor(reason, label = '') {
        super(`request shed (${reason})${label ? `: ${label}` : ''}`);
        this.name = 'GovernorRejection';
        this.shed = true;
        this.reason = reason;
    }
}

/**
 * A call that was sent but never came back inside its budget.
 *
 * `hass.callWS` has no timeout of its own: if Home Assistant accepts a service
 * call and never responds, the promise stays pending forever. Without a budget
 * here, such a call holds its concurrency slot permanently — three of them and
 * the card stops talking to Spotify entirely, silently, with nothing logged
 * (observed in the wild: `{active: 3, queued: 1, consecutiveFailures: 0}`).
 *
 * Timing out releases the slot. It cannot cancel the underlying request —
 * nothing in the HA websocket API can — so the original promise stays pending
 * and is simply abandoned.
 */
export class GovernorTimeout extends Error {
    constructor(label, ms) {
        super(`timed out after ${ms}ms${label ? `: ${label}` : ''}`);
        this.name = 'GovernorTimeout';
        this.timeout = true;
    }
}

/**
 * Failures that mean "the transport is unwell" rather than "Spotify said no".
 * Both trip the breaker (a flood of either is still a flood), but transport
 * failures are what the exponential backoff is really protecting against.
 */
export function isTransportError(e) {
    if (!e) return false;
    const msg = String(e.message || e.error?.message || '');
    const code = e.code ?? e.error?.code;
    return code === 3                        // HA's "Connection lost"
        || /connection lost|connection closed|websocket|timeout/i.test(msg);
}

const DEFAULTS = {
    maxConcurrent: 3,       // in flight at once; HA's socket is shared, stay modest
    maxQueue: 24,           // beyond this, oldest background work is shed
    maxWaitMs: 12000,       // a queued background call older than this is stale
    failureThreshold: 5,    // consecutive failures before the breaker opens
    openMs: 15000,          // first open duration
    maxOpenMs: 120000,      // ceiling for the exponential backoff
    // Per-call budgets. Background reads should give up quickly — the view that
    // wanted them has usually moved on. User actions get much longer: launching
    // Liked Songs or refreshing Connect devices legitimately takes many seconds.
    callTimeoutMs: 15000,
    userCallTimeoutMs: 45000,
    // When the backend has stopped answering entirely (see _looksStalled), back
    // off far harder than the normal ceiling. The observed cause is an upstream
    // quota window measured in hours — Spotify returned Retry-After: 8806 —
    // during which every retry is wasted and may extend the block further.
    // Two-minute retries across 2.5 hours is ~75 pointless requests.
    stalledOpenMs: 900000,   // 15 minutes
    stalledThreshold: 3,     // consecutive timeouts before we call it stalled
};

export class RequestGovernor {
    /**
     * @param {object} opts
     * @param {() => boolean} opts.canSend  Gate consulted at dispatch time
     *        (e.g. "is the WebSocket actually up"). Work waits, it isn't lost.
     * @param {(state: object) => void} [opts.onStateChange] Breaker notifications.
     */
    constructor(opts = {}) {
        Object.assign(this, DEFAULTS, opts);
        this.canSend = opts.canSend || (() => true);
        this.onStateChange = opts.onStateChange || null;

        this._queue = [];          // [{ task, priority, label, resolve, reject, enqueuedAt }]
        this._active = 0;
        this._activeEntries = new Set(); // in-flight entries, for diagnostics
        this._consecutiveFailures = 0;
        this._consecutiveTimeouts = 0; // drives the stalled-backend diagnosis
        this._stalled = false;
        this._openUntil = 0;       // breaker open through this timestamp
        this._openStreak = 0;      // consecutive trips, drives the backoff
        this._probeInFlight = false;
        this._drainTimer = null;
        this._destroyed = false;
    }

    /** True while the breaker is refusing background work. */
    get isOpen() {
        return Date.now() < this._openUntil;
    }

    /** Snapshot for diagnostics / the debug log. */
    get stats() {
        const now = Date.now();
        return {
            active: this._active,
            // Which services are in flight and for how long — the fastest way to
            // identify a call that Home Assistant is never going to answer.
            activeLabels: [...this._activeEntries].map(e =>
                `${e.label || 'anonymous'} (${now - e.startedAt}ms)`),
            queued: this._queue.length,
            queuedLabels: this._queue.map(e => e.label || 'anonymous'),
            open: this.isOpen,
            openFor: Math.max(0, this._openUntil - now),
            consecutiveFailures: this._consecutiveFailures,
            // True when the backend is accepting calls and never answering —
            // the signature of an upstream quota/rate block. See _looksStalled.
            stalled: this._stalled && this.isOpen,
        };
    }

    /**
     * Run `task` (an async thunk) under the governor.
     *
     * @param {() => Promise<any>} task
     * @param {object} [opts]
     * @param {'user'|'background'} [opts.priority] `user` jumps the queue and may
     *        probe an open breaker. Use it only for things a person just did.
     * @param {string} [opts.label] Service name, for diagnostics.
     * @returns {Promise<any>} the task's value, or rejects with GovernorRejection.
     */
    run(task, { priority = 'background', label = '' } = {}) {
        if (this._destroyed) {
            return Promise.reject(new GovernorRejection('destroyed', label));
        }

        const isUser = priority === 'user';

        // Breaker open: background work is refused outright. A user action is
        // allowed through as the half-open probe (one at a time) so the first
        // thing a person does after a blip is also what tests the connection.
        if (this.isOpen && !isUser) {
            return Promise.reject(new GovernorRejection('circuit-open', label));
        }

        return new Promise((resolve, reject) => {
            const entry = {
                task, label, resolve, reject,
                isUser,
                enqueuedAt: Date.now(),
            };
            // User work goes ahead of background work, FIFO within each class.
            if (isUser) {
                const firstBackground = this._queue.findIndex(q => !q.isUser);
                if (firstBackground === -1) this._queue.push(entry);
                else this._queue.splice(firstBackground, 0, entry);
            } else {
                this._queue.push(entry);
            }
            this._shedOverflow();
            this._drain();
        });
    }

    /**
     * Keep the queue bounded. Background entries are dropped oldest-first —
     * they are enrichment and paging, and a caller that asked 30 seconds ago
     * has almost certainly re-rendered since. User work is never shed here.
     */
    _shedOverflow() {
        while (this._queue.length > this.maxQueue) {
            const idx = this._queue.findIndex(q => !q.isUser);
            if (idx === -1) break; // all user work; let it through rather than drop it
            const [dropped] = this._queue.splice(idx, 1);
            dropped.reject(new GovernorRejection('queue-full', dropped.label));
        }
    }

    _drain() {
        if (this._destroyed) return;
        clearTimeout(this._drainTimer);
        this._drainTimer = null;

        const now = Date.now();

        // Expire background work that has been waiting too long to still matter.
        for (let i = this._queue.length - 1; i >= 0; i--) {
            const q = this._queue[i];
            if (!q.isUser && now - q.enqueuedAt > this.maxWaitMs) {
                this._queue.splice(i, 1);
                q.reject(new GovernorRejection('stale', q.label));
            }
        }

        while (this._queue.length && this._active < this.maxConcurrent) {
            const next = this._queue[0];

            // Half-open: exactly one probe at a time decides whether we recover.
            const probing = this.isOpen || this._openStreak > 0;
            if (probing) {
                if (this._probeInFlight || this._active > 0) break;
                if (!next.isUser && this.isOpen) break; // background waits out the open window
            }

            // Transport down: hold everything. Nothing is lost — background work
            // ages out via maxWaitMs, user work rides through once we reconnect.
            if (!this.canSend()) break;

            this._queue.shift();
            this._active++;
            next.startedAt = now;
            if (probing) this._probeInFlight = true;
            this._execute(next, probing);
        }

        // Re-check while work is parked (gate closed, breaker open, probe out).
        if (this._queue.length && !this._drainTimer) {
            const wait = this.isOpen
                ? Math.min(1000, Math.max(250, this._openUntil - now))
                : 250;
            this._drainTimer = setTimeout(() => { this._drainTimer = null; this._drain(); }, wait);
        }
    }

    async _execute(entry, wasProbe) {
        const budget = entry.isUser ? this.userCallTimeoutMs : this.callTimeoutMs;
        let timer = null;
        this._activeEntries.add(entry);
        try {
            // Race the call against its budget so a request Home Assistant never
            // answers cannot hold this slot forever. The losing promise is
            // abandoned, not cancelled — the websocket API offers no way to
            // retract an in-flight call.
            const value = await Promise.race([
                entry.task(),
                new Promise((_, rej) => {
                    timer = setTimeout(() => rej(new GovernorTimeout(entry.label, budget)), budget);
                }),
            ]);
            this._onSuccess();
            entry.resolve(value);
        } catch (e) {
            this._onFailure(e, wasProbe);
            entry.reject(e);
        } finally {
            clearTimeout(timer);
            this._activeEntries.delete(entry);
            this._active--;
            if (wasProbe) this._probeInFlight = false;
            this._drain();
        }
    }

    _onSuccess() {
        const wasOpen = this._openStreak > 0 || this.isOpen;
        this._consecutiveFailures = 0;
        this._consecutiveTimeouts = 0;
        this._stalled = false;
        this._openUntil = 0;
        this._openStreak = 0;
        if (wasOpen) this._notify('closed');
    }

    /**
     * Whether the backend has stopped answering altogether, as opposed to
     * failing. The distinguishing signature is repeated *timeouts* — calls that
     * were accepted and never answered — rather than errors, while the
     * transport itself is healthy.
     *
     * In practice this means the integration is blocked upstream: the observed
     * case was Spotify returning 429/QUOTA_EXCEEDED, which SpotifyPlus handles
     * by sleeping for the Retry-After (hours) without logging. Retrying into
     * that window is useless and may extend it, so it warrants a much longer
     * backoff than ordinary failures.
     */
    _looksStalled() {
        return this._consecutiveTimeouts >= this.stalledThreshold && this.canSend();
    }

    _onFailure(e, wasProbe = false) {
        this._consecutiveFailures++;
        if (e?.timeout) this._consecutiveTimeouts++;
        else this._consecutiveTimeouts = 0;

        // A failed half-open probe re-trips immediately — it was the one call
        // we allowed through specifically to answer "are we healthy yet?".
        if (!wasProbe && this._consecutiveFailures < this.failureThreshold && !this.isOpen) return;

        // Trip (or re-trip, after a failed probe) with exponential backoff.
        this._openStreak++;
        this._stalled = this._looksStalled();
        const openFor = this._stalled
            ? this.stalledOpenMs
            : Math.min(this.openMs * (2 ** (this._openStreak - 1)), this.maxOpenMs);
        this._openUntil = Date.now() + openFor;
        this._consecutiveFailures = 0;

        // Everything queued behind a dead connection is abandoned rather than
        // replayed later — replaying it is exactly what caused the storm.
        const abandoned = this._queue.splice(0, this._queue.length);
        abandoned.forEach(q => q.reject(new GovernorRejection('circuit-open', q.label)));

        this._notify('open', {
            openFor,
            transport: isTransportError(e),
            stalled: this._stalled,
        });
    }

    /**
     * Clear a stalled/open breaker on explicit user request ("Retry"). Distinct
     * from the automatic half-open probe: the user may know the upstream
     * problem is fixed long before the backoff would have expired.
     */
    resume() {
        this._openUntil = 0;
        this._openStreak = 0;
        this._consecutiveFailures = 0;
        this._consecutiveTimeouts = 0;
        this._stalled = false;
        this._notify('closed');
        this._drain();
    }

    _notify(state, detail = {}) {
        try {
            this.onStateChange?.({ state, ...detail, ...this.stats });
        } catch (_) { /* diagnostics must never break the caller */ }
    }

    /** Reject everything queued and stop. Call when discarding the owner. */
    destroy() {
        this._destroyed = true;
        clearTimeout(this._drainTimer);
        this._drainTimer = null;
        const pending = this._queue.splice(0, this._queue.length);
        pending.forEach(q => q.reject(new GovernorRejection('destroyed', q.label)));
    }
}
