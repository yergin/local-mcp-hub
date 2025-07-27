AI Code Principles
==================

1. No magic numbers

   1.1 Create a constant with a descriptive name

2. Defaults defined in on place only

   2.1 Define hard-coded defaults in one place

   2.2 If the setting can be set from a config, set it to defaults in the config loading code when it is not defines in the config

3. Defensive coding minimization

   3.1 No fallbacks: prefer failing early to hiding or deferring errors

   3.2 Assume values are not null unless explicitly designed to be optional

4. No superfluous comments

   4.1 Refrain from adding comments where the code is speaks for itself

   4.2 If a function needs a comment, it probably requires a better name or to be split up into simpler functions

   4.3 Comments should not describe or explain changes to the code nor versions

   4.4 Avoid numbered steps as creates more work if later changing the steps order

   4.4 Function comments should not refer to code that calls the function unless a special case has been added for the caller (which should be avoided)

   4.5 No emojis in comments

5. Code reuse

   5.1 Check whether a similar function or variable already exists before adding one

   5.2 Make functions generic where possible

   5.3 Separation of Concerns: split concerns up at every level into separate modules, files, classes, functions and data structures.

   5.4 Favour designs that don't use magic numbers and prefer automatically calculated values to configs

   5.5 Be careful to not overfit the design to the test data, make it flexible