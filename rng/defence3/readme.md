# Defence3 notes

## Cloud transport (units)

- Paired cloud towers now act as **unit transport portals**.
- Units can route through clouds during pathfinding when it is faster than direct travel.
- Teleport travel is only allowed through clouds owned by the **same team as the unit**.
- Practical example: entering `Cloud B1` teleports the unit to its paired endpoint `Cloud B2` (if both same-team cloud endpoints are alive).

### Pathing behavior

- Cloud links are part of A* path search as additional edges.
- Units are allowed to occupy their own cloud tile for path traversal.
- Teleport happens as part of following the computed path (on reaching the cloud endpoint tile).
