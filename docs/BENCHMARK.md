# Reproducible benchmark

Measured 2026-09-09T03:01:00.099Z on macOS 26.5, Apple M3 Pro (11 CPU cores, 18 GiB RAM), Node v24.19.0.

The checked-in generator in `scripts/test-performance.ts` creates 1,000,000 synthetic messages across iMessage, SMS, MMS, RCS, and an unknown service, with direct/group chats and attachment-only records. Message text is short and mostly stored as plain text. This is not a prediction for a large personal archive with Foundation-encoded bodies.

```sh
npm ci
npm run test:performance
# Optional smaller fixture:
npm run test:performance -- --messages=400000
```

| measurement | result |
| --- | ---: |
| Fixture construction | 4.074 s |
| Runtime startup | 6.852 s |
| Cold index and search | 19.530 s |
| Warm search | 11 ms |
| Refresh after one database update | 20.975 s |
| One-character warm search | 77 ms |
| Two authenticated HTTP clients | 52 ms |
| Index memory | 355,192,832 bytes |
| Index memory ceiling | 536,870,912 bytes |

Cold and warm searches look for `needle4242`, which occurs 100 times. The refresh changes one synthetic message to a unique value, then verifies that a search returns that value in the same runtime. Timings measure the local runtime; the separate HTTP measurement includes transport overhead. The script prints machine details and all measurements as JSON. Each run creates and removes its own synthetic database.

These are single-run measurements, with no percentile claim. The fixture's 60-second cold, 90-second refresh, and 2-second warm limits are checked in CI. A personal archive measured in the earlier RC.1 audit took about 61 seconds to build; that historical result has not been rerun here.
