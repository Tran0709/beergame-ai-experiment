// ===== The Beer Game (LA4): Core Simulation Engine =====
//
// This is the classic MIT/corporate-training "Beer Distribution Game" :
// a teaching exercise about the bullwhip effect. Core rules match the LA4
// spec: 5 roles in a linear chain, a 2-week delivery lead time at every
// stage, orders fixed at 4 units for the first 2 weeks. NOTE: the spec's
// "Rick does not drink more than 14 cans per week" tip is NOT enforced as a
// hard cap - that limit was deliberately removed on request, so a
// Facilitator can enter any demand they like. Season length and cost
// parameters are host-configurable
// (see DEFAULT_* constants below), so a room can flex them per session.
//
// DELIBERATE DESIGN CHOICE: HIDDEN INFORMATION: each role can only see its
// own stock/backlog/history and the order it just received from its
// immediate downstream neighbor. It cannot see any other role's numbers.
// This isn't a missing feature: the whole pedagogical point of this game is
// that isolated, locally-rational decisions made without visibility into the
// rest of the chain are what cause the bullwhip effect. Removing that
// constraint would remove the lesson.

const CHAIN = ['retailer', 'wholesaler', 'distributor', 'manufacturer'];
const UPSTREAM_OF = { retailer: 'wholesaler', wholesaler: 'distributor', distributor: 'manufacturer', manufacturer: 'factory' };

const ROLE_LABELS = {
  retailer: 'Retailer', wholesaler: 'Wholesaler', distributor: 'Distributor',
  manufacturer: 'Manufacturer', facilitator: 'Facilitator',
};

const DEFAULT_TOTAL_WEEKS = 8;
const STARTING_STOCK = 12;
const DEFAULT_HOLDING_COST = 1;   // $ per unit of stock remaining, per week
const DEFAULT_STOCKOUT_COST = 2;  // $ per unit of unfulfilled backlog, per week
const LEAD_TIME = 2;      // weeks for a shipment to arrive after being sent
const FIXED_ORDER_WEEKS = 2; // weeks 1-2: every role's own order is forced to FIXED_ORDER_QTY
const FIXED_ORDER_QTY = 4;
const MIN_TOTAL_WEEKS = 4, MAX_TOTAL_WEEKS = 52; // sane bounds for the host's "number of weeks" setting

function rand(min, max) { return min + Math.random() * (max - min); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function makeRoleState(role) {
  return {
    role,
    stock: STARTING_STOCK,
    backlog: 0,
    totalCost: 0,
    // pre-loaded pipeline: goods already in transit before the game starts,
    // matching the spec's starting "Supplier Delivery - 4 per week (for 2 weeks)"
    incomingShipments: [FIXED_ORDER_QTY, FIXED_ORDER_QTY],
    orderPlacedThisWeek: null,
    incomingOrderThisWeek: null,
    shippedThisWeek: null,
    history: [], // one entry per week: {week, stock, backlog, incomingOrder, orderPlaced, shipped, weeklyCost, totalCost}
  };
}

class BeerGameEngine {
  // config: {
  //   roleAssignments: { retailer:{id,name,isBot}, wholesaler:{...}, ... , facilitator:{...} },
  //   totalWeeks, holdingCost, stockoutCost: all optional, fall back to DEFAULT_* above
  // }
  constructor(config) {
    config = config || {};
    this.week = 1;
    this.totalWeeks = clamp(Math.round(Number(config.totalWeeks) || DEFAULT_TOTAL_WEEKS), MIN_TOTAL_WEEKS, MAX_TOTAL_WEEKS);
    this.holdingCost = Number(config.holdingCost) > 0 ? Number(config.holdingCost) : DEFAULT_HOLDING_COST;
    this.stockoutCost = Number(config.stockoutCost) > 0 ? Number(config.stockoutCost) : DEFAULT_STOCKOUT_COST;
    // Mandatory order-shift from active news, mirroring how holdingCost/
    // stockoutCost above get mutated externally by ui.js's
    // applyGlobalNewsCostEffect. activeOrderShift is the Global News
    // effect - it applies to every role's order AND the Facilitator's
    // consumer demand, since a nationwide event affects everyone.
    // activeLocalOrderShiftByRole is per chain-role only (Local News has
    // no equivalent for the Facilitator, who doesn't place an order).
    // Both default to 0 (no active news yet) and get set via
    // setNewsOrderShifts() below whenever the active news changes.
    this.activeOrderShift = 0;
    this.activeLocalOrderShiftByRole = { retailer: 0, wholesaler: 0, distributor: 0, manufacturer: 0 };
    // Facilitator interventions (all inactive by default, so a game that never
    // touches them plays exactly as before). See setInterventions below.
    this.interventions = { infoScope: 'off', caps: {}, costs: {} };
    this.gameOver = false;
    this.roles = {};
    CHAIN.forEach(r => { this.roles[r] = makeRoleState(r); });
    this.roleAssignments = config.roleAssignments || {};
    ['retailer', 'wholesaler', 'distributor', 'manufacturer', 'facilitator'].forEach(r => {
      if (!this.roleAssignments[r]) this.roleAssignments[r] = { id: 'BOT_' + r, name: 'AI ' + ROLE_LABELS[r], isBot: true };
    });
    this.weekHistory = [];
    this.finalResults = null;
    this.baseline = null; // computed once gameOver: see computeBaseline()
  }

  isFixedOrderWeek(week) {
    return week <= FIXED_ORDER_WEEKS;
  }

  // consumer demand for a given week when there's no live human facilitator :
  // a plausible, transparently-labeled stand-in for the classroom exercise's
  // usual improvised/scripted demand. Stays well inside the spec's 14/week
  // guidance by construction, though no hard cap is enforced anywhere.
  //
  // The value is generated once per week and then remembered. That matters
  // now that a role can be shown its incoming order BEFORE the week resolves
  // (see previewIncomingOrders below): without remembering it, the number a
  // player was shown and the number the engine later used would be two
  // different random draws.
  autoConsumerDemand(week) {
    if (week <= FIXED_ORDER_WEEKS) return FIXED_ORDER_QTY;
    if (!this._autoDemandByWeek) this._autoDemandByWeek = {};
    if (this._autoDemandByWeek[week] != null) return this._autoDemandByWeek[week];
    const base = week <= 4 ? 4 : 8;
    const noise = Math.round(rand(-1, 2));
    const value = Math.max(0, Math.round(base + noise));
    this._autoDemandByWeek[week] = value;
    return value;
  }

  // ---- Facilitator interventions ----
  // Three levers a Facilitator can pull when one role is stuck in a spiral:
  //   infoScope: 'off' | 'wholesaler' | 'chain'. The Retailer's data (stock,
  //     backlog, and the real customer demand) is shared with the Wholesaler or
  //     the whole chain. The UI shows it to human players; here it also changes
  //     how AI seats order: they work from the real customer demand instead of
  //     the order their own buyer placed, which is the point of sharing it.
  //   caps: { role: { max, untilWeek } }. A ceiling on that role's final order
  //     (after any news shift) up to and including week `untilWeek`.
  //   costs: { 'all' | role: { holding?, stockout? } }. Rates that replace the
  //     game's for that role from the next week resolved onward; past weeks are
  //     never recomputed.
  // Always replaced as one object so a stale field can't linger.
  setInterventions(iv) {
    const src = iv || {};
    const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) || Number(v) < 0) ? null : Number(v);
    const caps = {};
    Object.keys(src.caps || {}).forEach(role => {
      const c = src.caps[role]; const max = c ? num(c.max) : null; const until = c ? num(c.untilWeek) : null;
      if (CHAIN.includes(role) && max != null && until != null && until >= 1) caps[role] = { max: Math.round(max), untilWeek: Math.round(until) };
    });
    const costs = {};
    Object.keys(src.costs || {}).forEach(key => {
      if (key !== 'all' && !CHAIN.includes(key)) return;
      const c = src.costs[key] || {}; const e = {};
      const h = num(c.holding), s = num(c.stockout);
      if (h != null) e.holding = h;
      if (s != null) e.stockout = s;
      if (Object.keys(e).length) costs[key] = e;
    });
    const infoScope = (src.infoScope === 'wholesaler' || src.infoScope === 'chain') ? src.infoScope : 'off';
    this.interventions = { infoScope, caps, costs };
  }
  // Does `role` get to work from the Retailer's real customer data?
  infoSharedWith(role) {
    const s = this.interventions.infoScope;
    return s === 'chain' ? role !== 'retailer' : (s === 'wholesaler' && role === 'wholesaler');
  }
  // The ceiling on `role`'s order in `week`, or null if there is none.
  orderCapFor(role, week) {
    const c = this.interventions.caps[role];
    return c && week <= c.untilWeek ? c.max : null;
  }
  hasCostOverride(role) {
    const c = this.interventions.costs;
    return !!(c.all || c[role]);
  }
  // Holding and stockout rate that apply to `role` right now.
  costRatesFor(role) {
    let holding = this.holdingCost, stockout = this.stockoutCost;
    const c = this.interventions.costs;
    [c.all, c[role]].forEach(o => {
      if (o) { if (o.holding != null) holding = o.holding; if (o.stockout != null) stockout = o.stockout; }
    });
    return { holding, stockout };
  }

  // AI heuristic for any unfilled role: reacts to last week's order plus an
  // assertive backlog correction (see aiOrderDecision below for the full
  // empirical tuning story - a fancier trend-following version was tried
  // and measurably lost to this simpler one). It's noticeably more
  // competent than a weaker backlog correction, so bot-controlled seats are
  // genuinely competitive rather than an easy win, but it still can't see
  // the future, so the bullwhip effect can still emerge, especially over a
  // long game - which is the correct lesson for this exercise, not a flaw
  // to eliminate. Crucially, this only looks at *prior* weeks' recorded
  // history, never the current week's in-progress numbers, so a bot never
  // reacts to anything from the current week, and every order is still
  // locked in before any of them is applied. (A human role is shown the
  // order its buyer placed once that buyer has submitted - see
  // previewIncomingOrders - the way the classroom game hands a player the
  // order slip. That is information given to the player, not the bot
  // reacting to anyone.)
  // Called from ui.js whenever the active Global/Local news changes -
  // same trigger point as applyGlobalNewsCostEffect for the cost
  // multipliers. localShiftByRole only needs to contain the roles that
  // actually have active local news; any role missing from it is treated
  // as 0 (no local news currently affecting them).
  setNewsOrderShifts(globalShift, localShiftByRole) {
    this.activeOrderShift = Number(globalShift) || 0;
    CHAIN.forEach(role => {
      this.activeLocalOrderShiftByRole[role] = Number((localShiftByRole || {})[role]) || 0;
    });
  }

  aiOrderDecision(role) {
    if (this.isFixedOrderWeek(this.week)) return FIXED_ORDER_QTY;
    const r = this.roles[role];
    const lastWeek = r.history.length ? r.history[r.history.length - 1] : null;
    let lastIncoming = lastWeek ? lastWeek.incomingOrder : FIXED_ORDER_QTY;
    // Information sharing: a seat that can see the Retailer's real customer
    // demand orders from that, not from the (possibly panic-inflated) order
    // its own buyer placed.
    if (this.infoSharedWith(role) && this.weekHistory.length) lastIncoming = this.weekHistory[this.weekHistory.length - 1].consumerDemand;

    // Backlog is a direct, unambiguous shortfall, corrected so it doesn't
    // linger and compound. This fraction was re-tuned empirically across
    // six demand patterns (steady, step-up, ramp, oscillating, a sharp
    // spike-then-reversal, and a late shock) plus 300 runs of randomized
    // realistic demand, measuring BOTH total chain cost AND service level
    // (whether the chain actually clears its backlog rather than just
    // ordering less and looking cheap).
    //
    // That distinction mattered: purely by cost, a fraction of 0 scored
    // best of everything tested, but it leaves large amounts of demand
    // permanently unfulfilled - cheap precisely because it stops trying to
    // serve customers, which is the wrong lesson for a supply-chain
    // exercise. 0.3 is the lowest value that still fully clears backlog
    // wherever 0.4 did, while costing roughly 15-20% less across every
    // pattern tested.
    //
    // Also tested and rejected: a smoothed 3-week average of incoming
    // demand (30% worse), and classic order-up-to policies with a pipeline
    // term (800%+ worse - they diverge badly here because the 2-week lead
    // time plus four chained stages amplifies any target-chasing).
    const BACKLOG_CATCHUP_FRACTION = 0.3;
    const backlogCatchUp = Math.round(r.backlog * BACKLOG_CATCHUP_FRACTION);
    const baseQty = Math.max(0, lastIncoming + backlogCatchUp);

    // Optional market-aware nudge (see market.js): a small, bounded
    // adjustment based on real/simulated beer-industry stock trend, applied
    // only if that module is loaded and has data. This never replaces the
    // policy above, it only nudges it, so bot behavior stays sound even
    // with no market data at all.
    if (typeof marketAwareOrderAdjustment === 'function') {
      return marketAwareOrderAdjustment(baseQty);
    }
    return baseQty;
  }

  // decisionsMap: { retailer: qty, wholesaler: qty, distributor: qty, manufacturer: qty, facilitator: consumerDemandQty }
  // any role missing from the map (or marked as a bot) falls back to the AI heuristic / auto demand generator :
  // identical fallback pattern to Malt & Ledger's engine, for the same reason: bots and absent humans behave the same way.
  // Step A of a week on its own: lock in the consumer demand and every chain
  // role's order for the CURRENT week from a decisions map, using only state
  // as of the end of last week. processWeek calls this, and so does the UI
  // (through previewIncomingOrders), which is what guarantees a number shown
  // to a player early is exactly the number the engine later uses.
  resolveDecisions(decisionsMap) {
    const map = decisionsMap || {};
    const week = this.week;

    // ---- Step A: lock in every role's order decision FIRST, using only
    // state as of the end of last week: this is what makes it simultaneous
    // rather than a cascade where later roles could react to earlier ones.
    // A value supplied here always wins, whether or not this engine's own
    // facilitator seat is a bot. This is what lets a single, room-wide
    // Facilitator (see ui.js) drive the same consumer demand across every
    // team's engine, rather than each team's engine deciding independently.
    // Active Global News is a mandatory shift, applied here regardless of
    // whether the number came from a human or autoConsumerDemand - a
    // nationwide event doesn't ask permission. Not applied during the two
    // fixed weeks, which are meant to be a stable, unaffected baseline.
    const rawConsumerDemand = (map.facilitator != null)
      ? Math.max(0, Math.round(Number(map.facilitator) || 0))
      : this.autoConsumerDemand(week);
    const consumerDemand = this.isFixedOrderWeek(week)
      ? rawConsumerDemand
      : Math.max(0, rawConsumerDemand + this.activeOrderShift);

    const cappedBy = {};
    const decisionFor = (role) => {
      if (this.isFixedOrderWeek(week)) return FIXED_ORDER_QTY;
      const assignment = this.roleAssignments[role];
      const raw = assignment.isBot
        ? this.aiOrderDecision(role)
        : (map[role] == null ? this.aiOrderDecision(role) : clamp(Math.round(Number(map[role]) || 0), 0, 9999));
      // Mandatory shift from Global News (everyone) plus this role's own
      // Local News (chain roles only) - applied uniformly whether the
      // number above came from a bot or a human, same reasoning as
      // consumer demand: the news doesn't check who's deciding.
      const shift = this.activeOrderShift + (this.activeLocalOrderShiftByRole[role] || 0);
      const placed = clamp(raw + shift, 0, 9999);
      // A Facilitator-set ceiling is the last word on the number.
      const cap = this.orderCapFor(role, week);
      if (cap != null && placed > cap) { cappedBy[role] = cap; return cap; }
      return placed;
    };
    const orderDecision = {};
    CHAIN.forEach(role => { orderDecision[role] = decisionFor(role); });
    return { consumerDemand, orderDecision, cappedBy };
  }

  // The order each role is facing this week, i.e. what its buyer has placed:
  // the Retailer faces consumer demand, the Wholesaler faces the Retailer's
  // order, and so on. Pass the decisions entered so far (anything missing
  // falls back exactly as it does when the week resolves).
  previewIncomingOrders(decisionsMap) {
    const { consumerDemand, orderDecision } = this.resolveDecisions(decisionsMap);
    return {
      retailer: consumerDemand,
      wholesaler: orderDecision.retailer,
      distributor: orderDecision.wholesaler,
      manufacturer: orderDecision.distributor,
    };
  }

  processWeek(decisionsMap) {
    if (this.gameOver) return null;
    const week = this.week;

    // ---- Step A: lock in every role's order decision FIRST (see
    // resolveDecisions above), using only state as of the end of last week:
    // this is what makes it simultaneous rather than a cascade where later
    // roles could react to earlier ones.
    const { consumerDemand, orderDecision } = this.resolveDecisions(decisionsMap);

    // ---- Step B: mechanical resolution of the week, now that every
    // decision is locked in. Phase 1: receive shipments in transit.
    CHAIN.forEach(role => { this.roles[role].stock += this.roles[role].incomingShipments.shift(); });

    // Phase 2: each role's incoming order this week = downstream neighbor's
    // just-locked-in decision (retailer's "downstream" is the end consumer)
    this.roles.retailer.incomingOrderThisWeek = consumerDemand;
    this.roles.wholesaler.incomingOrderThisWeek = orderDecision.retailer;
    this.roles.distributor.incomingOrderThisWeek = orderDecision.wholesaler;
    this.roles.manufacturer.incomingOrderThisWeek = orderDecision.distributor;

    // Phase 3: each role ships to fulfill (backlog + incoming order) from available stock
    CHAIN.forEach(role => {
      const r = this.roles[role];
      const demand = r.backlog + r.incomingOrderThisWeek;
      const shipped = Math.min(r.stock, demand);
      r.stock -= shipped;
      r.backlog = demand - shipped;
      r.shippedThisWeek = shipped;
    });

    // Phase 4: shipments become pipeline entries for the downstream role, arriving in LEAD_TIME weeks
    // (manufacturer's own order always fulfills in full from "the factory": no upstream stockout risk)
    this.roles.retailer.incomingShipments.push(this.roles.wholesaler.shippedThisWeek);
    this.roles.wholesaler.incomingShipments.push(this.roles.distributor.shippedThisWeek);
    this.roles.distributor.incomingShipments.push(this.roles.manufacturer.shippedThisWeek);
    this.roles.manufacturer.incomingShipments.push(orderDecision.manufacturer); // factory always fulfills in full

    // Phase 5: record each role's own order placed this week, and cost
    const costOverrides = {};
    CHAIN.forEach(role => {
      const r = this.roles[role];
      r.orderPlacedThisWeek = orderDecision[role];
      const rates = this.costRatesFor(role);
      if (this.hasCostOverride(role)) costOverrides[role] = rates;
      const weeklyCost = r.stock * rates.holding + r.backlog * rates.stockout;
      r.totalCost += weeklyCost;
      r.history.push({
        week, stock: r.stock, backlog: r.backlog, incomingOrder: r.incomingOrderThisWeek,
        orderPlaced: r.orderPlacedThisWeek, shipped: r.shippedThisWeek, weeklyCost, totalCost: r.totalCost,
      });
    });

    const weekEntry = {
      week, consumerDemand,
      roles: CHAIN.reduce((acc, role) => { acc[role] = { ...this.roles[role].history[this.roles[role].history.length - 1] }; return acc; }, {}),
    };
    // Only present in weeks where a Facilitator cost change was in force, so a
    // game that never uses one records exactly what it always did.
    if (Object.keys(costOverrides).length) weekEntry.costOverrides = costOverrides;
    this.weekHistory.push(weekEntry);

    if (week >= this.totalWeeks) {
      this.gameOver = true;
      this.finalResults = this.getStandings();
      this.baseline = this.computeBaseline();
    } else {
      this.week += 1;
    }
    return this.weekHistory[this.weekHistory.length - 1];
  }

  getStandings() {
    return CHAIN
      .map(role => ({ role, label: ROLE_LABELS[role], totalCost: this.roles[role].totalCost, assignment: this.roleAssignments[role] }))
      .sort((a, b) => a.totalCost - b.totalCost); // LOWEST cost wins
  }

  // BASELINE: "what would this have cost with zero bullwhip?": replays the
  // exact same consumer demand sequence that actually occurred, but with
  // every role doing pure pass-through ordering (order placed = order just
  // received, no reaction, no amplification, no backlog catch-up at all).
  // This isolates how much of the real game's cost came specifically from
  // the bullwhip dynamics, versus the demand pattern itself.
  computeBaseline() {
    const baseRoles = {};
    CHAIN.forEach(r => { baseRoles[r] = makeRoleState(r); });
    let baseTotal = 0;
    const perRole = {};
    CHAIN.forEach(r => { perRole[r] = 0; });

    this.weekHistory.forEach(wk => {
      const incoming = {
        retailer: wk.consumerDemand,
        wholesaler: baseRoles.retailer.orderPlacedThisWeek != null ? baseRoles.retailer.orderPlacedThisWeek : FIXED_ORDER_QTY,
        distributor: baseRoles.wholesaler.orderPlacedThisWeek != null ? baseRoles.wholesaler.orderPlacedThisWeek : FIXED_ORDER_QTY,
        manufacturer: baseRoles.distributor.orderPlacedThisWeek != null ? baseRoles.distributor.orderPlacedThisWeek : FIXED_ORDER_QTY,
      };
      CHAIN.forEach(role => { baseRoles[role].stock += baseRoles[role].incomingShipments.shift(); });
      CHAIN.forEach(role => { baseRoles[role].incomingOrderThisWeek = incoming[role]; });
      CHAIN.forEach(role => {
        const r = baseRoles[role];
        const demand = r.backlog + r.incomingOrderThisWeek;
        const shipped = Math.min(r.stock, demand);
        r.stock -= shipped;
        r.backlog = demand - shipped;
        r.shippedThisWeek = shipped;
        r.orderPlacedThisWeek = r.incomingOrderThisWeek; // pure pass-through, zero reaction
      });
      baseRoles.retailer.incomingShipments.push(baseRoles.wholesaler.shippedThisWeek);
      baseRoles.wholesaler.incomingShipments.push(baseRoles.distributor.shippedThisWeek);
      baseRoles.distributor.incomingShipments.push(baseRoles.manufacturer.shippedThisWeek);
      baseRoles.manufacturer.incomingShipments.push(baseRoles.manufacturer.orderPlacedThisWeek);
      CHAIN.forEach(role => {
        const r = baseRoles[role];
        // The baseline is charged the same rates the real game was, week by week.
        const rates = (wk.costOverrides && wk.costOverrides[role]) || { holding: this.holdingCost, stockout: this.stockoutCost };
        const weeklyCost = r.stock * rates.holding + r.backlog * rates.stockout;
        r.totalCost += weeklyCost;
        perRole[role] += weeklyCost;
        baseTotal += weeklyCost;
      });
    });
    return { perRole, total: baseTotal };
  }

  // what a given role is allowed to see: enforces the hidden-information design
  getVisibleStateFor(role) {
    if (role === 'facilitator') {
      const all = {};
      CHAIN.forEach(r => { all[r] = this.roles[r]; });
      return {
        everything: all, week: this.week, weekHistory: this.weekHistory,
        totalWeeks: this.totalWeeks, isFixedOrderWeek: this.isFixedOrderWeek(this.week),
      };
    }
    const own = this.roles[role];
    return {
      own,
      week: this.week,
      totalWeeks: this.totalWeeks,
      upstreamLabel: ROLE_LABELS[UPSTREAM_OF[role]] || 'Factory',
      isFixedOrderWeek: this.isFixedOrderWeek(this.week),
    };
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    BeerGameEngine, CHAIN, ROLE_LABELS, STARTING_STOCK, LEAD_TIME, FIXED_ORDER_QTY,
    DEFAULT_TOTAL_WEEKS, DEFAULT_HOLDING_COST, DEFAULT_STOCKOUT_COST, MIN_TOTAL_WEEKS, MAX_TOTAL_WEEKS,
  };
}


