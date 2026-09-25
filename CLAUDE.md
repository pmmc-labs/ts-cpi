# ts-cpi

A TypeScript prototype of the slight control plane interpreter. See `README.md`
for layout and commands, `DECISIONS.md` for choices made, and `TUTORIAL.md` for
the language.

## Code style

- **Indent with 4 spaces, never 2**, in all code: TypeScript, `.slight` (CPI)
  source, CPI source embedded in tests, code blocks in Markdown, and JSON.
- CPI (`.slight`) code indents 4 spaces per open parenthesis:

  ```lisp
  (defun sum-to (n acc)
      (if (= n 0)
          acc
          (sum-to (- n 1) (+ acc n))))
  ```

## Commands

- `npm run check`: type-check.
- `npm test`: all tests.
- `node bin/cpi.ts file.slight ...`: run a program.
