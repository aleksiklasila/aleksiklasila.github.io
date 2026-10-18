
# This is a preliminary analyzis, not a full plan. At the end there are corrections, and notes. Use this for directions, not exactly implementation details, as those may need to be tested and studided in further detail.

# Responsive, stable crowd movement across TPS

## Objective

Improve group responsiveness, preserve shared flow, and reduce idle agitation and overlap.

Optimize the 1-TPS experience toward the 20-TPS experience **without degrading 20 TPS**. Differences from less frequent simulation updates—including rally latency—are expected. Cross-TPS similarity is a continuing optimization goal, not a numerical acceptance gate.

Responsiveness takes priority over perfect spacing. Minimize overlap within that constraint.

## Movement model

Replace blanket contact slowdown with flow-relative response:

- Prepare intended navigation movement before applying crowd response. Compare intended velocities so existing slowdowns do not propagate backward through queues.
- Calculate local friendly flow, activity, and directional coherence during the existing neighbour traversal.
- Resist relative closing motion along contact normals while preserving shared forward travel, tangential sliding, and movement away from contact.
- Retain geometric separation under compression, including between units moving together.
- Let stationary friends yield readily: initially assign 75% of movement-related correction to the resting neighbour and 25% to the incoming unit. Use equal shares between moving units and opposing teams; honour hold-position orders.
- Use flow as the reference for damping, without replacing orders or automatically carrying stationary units along.
- Distinguish conflicting streams from resting crowds: opposing movement can have a near-zero average velocity despite substantial activity.

For neighbours already discovered by the contact traversal, use their intended relative movement to predict approaching compression over the update interval.

## Stability and simulation integration

Separate immediate movement-related contact response from damped geometric separation:

- Apply closing-motion response immediately.
- Damp separation-induced sideways agitation strongly during coherent travel, longitudinal fluctuations moderately, and idle residual movement in both axes.
- Integrate damping and displacement using elapsed simulation time and analytic exponential response.
- Express geometric relaxation as `1 − exp(−delta / relaxationTime)`, rather than a fixed correction fraction per update.
- Bound correction by measured compression and clearance. Revalidate cached forces instead of extrapolating obsolete pushes through long updates.
- Add hysteresis and sleeping for settled contacts. New orders, incoming contacts, increased compression, and changed flow wake units.
- Keep resting units unanchored so they can yield.

Refactor execution into **prepare → resolve → commit**:

1. Produce wall-safe candidate navigation coordinates once.
2. Resolve contacts and flow from immutable candidates and starting positions.
3. Commit combined movement, spatial membership, visibility, and interpolation origins.

Use packed candidate coordinates, deterministic contact/flow accumulation, and existing separation carry storage where possible. Apply the same contract to JavaScript fallbacks. Execute combat, resource charges, worker actions, and path progression only once.

Add no per-render-frame crowd simulation, global iterative solver, or timestep subdivision in the initial implementation.

## Navigation adjustments

- Preserve lateral position through demonstrably open routes instead of repeatedly contracting units toward common lines.
- Keep constrained steering around walls and genuine bottlenecks.
- Prevent temporary obstruction behind moving allies from becoming premature arrival or prolonged waiting.
- Evaluate arrival from committed movement near a settled destination crowd.
- Immediately invalidate obsolete waiting and arrival state on a changed rally destination.

Implement these separately from contact changes so their effects can be measured independently.

## Experimental scenarios and measurements

Create a deterministic scenario runner covering:

- Idle sparse and dense crowds.
- Open-ground travel, turns, and changed rally points.
- Repeated rally toward a crowd’s centre.
- Groups escaping from larger friendly groups.
- Entry into stationary friends.
- Parallel streams, overtaking, crossing, and opposing streams.
- Narrow passages and corners.
- Attack advance, engagement, and disengagement.

Run homogeneous and mixed-size groups, workers, and relevant collision layers at **1, 2, 5, 10, and 20 TPS**, using equal elapsed simulation time and multiple seeds. Include increasing group sizes and separate large-population performance workloads.

Measure:

- Useful progress, travel speed, and response after an order is applied.
- Front, middle, and rear-cohort progress and queue recovery.
- Escape time and throughput.
- Lateral agitation relative to flow.
- Idle cumulative travel, drift, and settling.
- Crowd footprint, spacing, overlap severity, and overlap duration.
- Simulation cost, update-time tails, and added memory.

Sample interpolated presentation at a fixed 60 Hz as well as simulation endpoints. Report command scheduling latency separately from movement responsiveness.

## Iterative optimization and safeguards

Establish the current baseline, then implement and evaluate:

1. Intended-flow contact response.
2. Time-based stabilization and prediction.
3. Navigation lane and arrival corrections.
4. Joint tuning across scenarios and TPS.

Tune a small global parameter set: contact strength, yielding share, geometric relaxation, directional damping, and sleep/wake thresholds. Use held-out seeds to catch overfitting.

For each experiment:

- Inspect individual scenarios and cohort distributions; do not rely on an overall average.
- Prefer changes that improve responsiveness, stability, spacing, or cross-TPS consistency without worsening 20-TPS behaviour or materially increasing cost.
- Preserve the strongest validated version for comparison.
- Use remaining discrepancies to select the next experiment.

Continue while measured discrepancies remain meaningfully improvable. Stop a line of optimization when repeated experiments produce diminishing gains or require unacceptable computation, memory, latency, or behavioural tradeoffs. Document those limits and retain the best observed balance.

Treat wall safety, deterministic helpers, snapshot restoration, valid coordinates, and continuous rendering/picking as correctness requirements. Treat cross-TPS similarity and overlap reduction as optimization goals.

Validate the final candidate interactively with `4M-1K.json`, benchmark identical workloads against the baseline, rebuild both WASM variants, and update simulation compatibility and cache versions.

# This is the audit on the plan so far:

The direction is sound, but I see several issues worth correcting before implementation:
1. The proposed refactor could be expensive. Preparing movement, resolving contacts, and committing separately introduces extra memory traffic and synchronization across millions of units. The plan should first establish whether this separation is necessary, then choose the cheapest implementation that provides consistent inputs. Constant work per unit does not automatically mean negligible cost.
2. Intended flow and actual motion serve different purposes. Intended flow is useful for preserving responsiveness and avoiding queue feedback. Actual motion is needed to detect blocked units and ongoing drift. Using intent alone could treat a stationary traffic jam as healthy flowing traffic. The plan should use intent for the preferred flow and measured motion for stability and obstruction feedback.
3. “Respect average flow” needs a precise boundary. Damping should suppress unwanted motion relative to the flow while preserving deliberate turns, overtaking, escape, and new orders. Otherwise this could replace contact friction with a different resistance to manoeuvring. A new order must immediately take precedence over the previous flow estimate.
4. The time calculations must account for contact sampling cadence. With staggered sampling, a force can be older than one simulation update. Using only the current delta would still produce different behaviour across TPS. Pressure prediction, decay, and expiry need to account for how long ago the contact information was sampled.
5. Some proposed constants are prematurely fixed. The 60-degree flow grouping and 75/25 yielding split should be initial experimental values. In particular, a sudden angular cutoff could make neighbours repeatedly enter and leave the flow group. Smooth weighting would be preferable. Yielding also needs to consider whether the neighbour actually has space to move.
6. Sleeping and damping could conceal unresolved compression. A crowded group must not become quiet merely because pressure vectors cancel or movement becomes tiny. Rest detection should consider compression separately from net force. Conversely, small persistent overlap should not keep an otherwise stable crowd awake forever.
7. The correction bounds need to cover the combined response. Bounding geometric separation alone does not prevent a large contact reaction from throwing units sideways at low TPS. The plan should constrain excessive contact-induced displacement as a whole, while leaving legitimate navigation movement responsive.
8. The optimization process needs clearer comparisons. Keep both the current behaviour and the best validated candidate as references. Compare a new candidate against each at every TPS, with repeated timings and held-out scenarios. Otherwise successive small regressions can become the new baseline. Also test changing TPS during a scenario: changing unit counts will expose transitions between operating conditions.
I would retain the overall approach, but make these corrections explicit. The biggest risks are adding too much simulation overhead, damping intentional movement, and mistaking intended flow for actual progress. Those deserve attention before tuning separation strength.

# user note

Take from this what is useful, discard what is not.
Currently main issues are restlesness at stationary state, and units blocking each other when moving to effectively the same direction / location due to the grouping, and separation, and so on at 1 tps, and at 20tps, just slightly different in each scenario.
