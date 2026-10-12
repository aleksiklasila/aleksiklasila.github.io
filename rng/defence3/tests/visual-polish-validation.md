# Rendering polish — 2026-10-12

Small rendering changes, with no simulation or gameplay changes:

- Explicit sprite mip gradients avoid dependence on fragment discard / pixel alignment. Normalize premultiplied owner masks as well as sprite colors to remove pale filtered fringes.
- Contrast-limited sharpening and gentler grading reduce clipped highlights and black halos. Softer model/miniature outlines and slightly dimmer painted panels reduce the glossy appearance.
- Type miniatures remain visible farther away: the dot transition spans 1.25–6 CSS pixels per tile, previously 2–8. Detailed geometry budgets do not increase.
- Middle models use the existing coarse mesh, capped at 2,400 units and 800 structures (previously 4,000 / 1,200).
- 2D detail membership uses the same tick-aligned camera cache as 3D. Camera projection continues every display frame; jumps and mode changes refresh immediately.
- Distant combat records aggregate by depth even when the foreground is close. Aggregation cells stay fixed in the world; the maximum cosmetic instance budget is 6,000.

Edge / RTX 2060, High preset, `300000-1000.json`: **600,000 units plus 60,262 structures**. Full visibility, 1600×1000 browser, 1096×851 game viewport. Each camera case measured for 10 seconds after 5 seconds of warmup. These are short local measurements, not a locked-60 or long-battle guarantee.

| Camera case | Average FPS | p95 frame ms | Average GPU ms |
|---|---:|---:|---:|
| 2D stopped | 113.2 | 16.47 | 2.45 |
| 2D panning | 110.6 | 16.55 | 2.61 |
| 3D stopped, pitch 0.38 | 99.8 | 16.80 | 3.28 |
| 3D rotating, pitch 0.38 | 65.9 | 33.47 | 5.29 |

Frozen-snapshot fractional-pixel probes varied average luminance by 0.064% in 2D and 0.029% in 3D. Returning to the identical camera reproduced the same luminance. This checks renderer output, not monitor response or desktop HDR/compositor behavior.

The existing solo attack-move harness (15-second cases, 1920×1080) measured 114–116 FPS across tilted, close 3D and close 2D views; p95 was 8.76–8.87 ms, with isolated 50–108 ms maximum gaps. Worker TPS was 14–17. This harness issues attack-move orders; it does not guarantee the viewport contains a sustained crowded melee.

No browser or WebGL errors. Thirteen focused regression suites passed, including LOD budgets/cache behavior, miniature preparation, combat aggregation, graphics settings, flat batches, lighting, persistent instance uploads, frustum culling, picking and occupied walk surfaces. Raw results and four final screenshots are alongside this file as `lod-visual-polish-final*`; attack-move results are in `visual-polish-combat.json`.

The benchmark now avoids nesting its GPU timer with the renderer timer (the old instrumentation produced INVALID_OPERATION). `LOD_POLISH=1` adds paired stopped/moving cases and luminance checks; `LOD_DURATION` sets measurement milliseconds. The hardest rotating camera still has frame-time spikes: further work would require profiling scene preparation and simulation contention, beyond these rendering mitigations.
