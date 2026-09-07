# Gate tally

This file records, per rule, every time a gate rejected a deliverable and
what it caught. It is a measurement log, not a design document. Later
tooling in this project builds on top of the entries here.

| # | Date | Rule | What it caught |
|---|------|------|----------------|
| 1 | 2026-09-07 | named-spec-files-fail-loud | A build step was requested that named a specification file, but that file was not present in the repo. A file with a very similar name was present instead. The gate stopped the build instead of quietly substituting the similar file for the missing one, so nothing got built on a source that was never verified. |
| 2 | 2026-09-07 | full-finding-list | An independent reviewer checked the prose gate against committed state and reported four ways it passed while checking nothing: a banned word in capitals, a run outside a git repository, a path that did not exist, and a directory given as an argument. Each one exited zero. The reviewer also reported that the gate never said which file had failed. |
| 3 | 2026-09-07 | induced-failure-required | A fix for the gate was tested only against files made up for the test. Running it against the real repository showed the fix had joined two filenames into one path that could not be opened. The made-up cases had all passed. |
| 4 | 2026-09-07 | full-finding-list | The second fix asked git for a newline separated file list. git escapes any path holding a non-ASCII character, so a file named with an accent came back as text that could not be opened. The gate stopped with an error blaming the file, and a tracked file holding banned prose went unchecked. A reviewer found it and it was reproduced before any change was made. |
| 5 | 2026-09-07 | full-finding-list | The file list was matched against the current directory instead of the repository root. Run from the rules directory the gate checked nothing and reported success. Run from the docs directory it checked one file out of seven and reported success. A reviewer found it and it was reproduced from every directory in the repository. |
| 6 | 2026-09-07 | induced-failure-required | Widening the gate to cover the rule records caught a banned term on its first run, in the record describing the cross cutting audit. The term had been there since the records were written and no earlier run could have seen it. |
