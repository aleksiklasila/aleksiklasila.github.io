Full regression run started in the background.

Scope: every tests/*.test.cjs file, in both SIM_WORKER=0 and SIM_WORKER=1 modes, using the repository's tests/run-regressions.cjs runner. See test-manifest.txt for the exact file list. Concurrency is 1 to avoid overlapping heavy simulation/scale tests. Standalone benchmark, browser/manual diagnostic, server, fixture generator and helper scripts are outside this automated regression suite.

results.json is rewritten after each completed test. Each result contains mode, file, exit status, complete captured stdout/stderr, timeout flag and elapsed milliseconds. Nonzero status or timedOut=true indicates failure; failures do not stop subsequent tests.
progress.log contains one PASS/FAIL line per completed test and a final total when the run finishes. runner-errors.log contains runner-level errors. run-info.json records the process ID, command and expected job count. Compare results.json's row count to totalJobs in run-info.json before treating the run as complete.

For a future session: inspect progress.log and results.json, summarize failures and timeouts by mode/file, and investigate them. Do not assume the tests passed merely because this run was launched. The files accumulate while the detached Node process is running.

The initial detached launch did not survive. Restarted in persistent Codex command session 67173; confirmed the first three tests produced PASS results. Do not terminate that session while the suite is running.
