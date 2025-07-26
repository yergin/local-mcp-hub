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

   4.3 Comments should not describe or explain changes to the code

   4.4 Function comments should not refer to code that calls the function unless there is a problem with the use of the function

   4.5 No emojis in comments

5. Code reuse

   5.1 Check whether a similar function or variable already exists before adding one

   5.2 Make functions generic where possible

   5.3 Separation of Concerns: split concerns up at every level into separate modules, files, classes, functions and data structures.