# Reader-testing a design doc

A doc makes sense to whoever wrote it, because they hold everything it leaves out. Test it on a
reader who holds nothing.

1. **Write 5 to 10 questions** the doc's readers would really ask: the decision it wants ("Which
   option do you recommend, and why?"), what it costs, what it touches, what happens to today's
   behaviour, what is still open, and one or two about the awkward case. Write the answer you
   expect beside each, for yourself.
2. **Brief a Grunt** (`general-purpose`, Sonnet, medium effort: `citadel:subagents`) with only
   the doc's path and the questions, none of your own context or expected answers:

   > Read only this file: `<path>`. Don't open any other file. For each question, answer from the
   > doc alone, quote the line you answered from, and say "the doc doesn't say" when it doesn't.
   > Then list: what is ambiguous (two readings and both), what the doc assumes a reader already
   > knows, and anything that contradicts itself. Under 400 words.

   An HTML doc counts as text: tell the Grunt the picture-only parts (art, live boards) are out of
   scope, and test any claim that rests on them by asking whether the text says it too.
3. **Score it:** a question it answered wrongly, or couldn't answer when the doc should, is a gap.
   So is every assumed term and every contradiction.
4. **Fix the doc,** not the questions. Rerun only when the fixes were big.

It passes when the Grunt answers the decision questions right and finds nothing new that a reader
would trip on. Say in one line, when you show the doc, what the test caught.
