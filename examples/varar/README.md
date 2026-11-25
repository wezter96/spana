# Spana + Varar example

[Varar](https://varar.dev) runs Markdown documents as tests. Spana drives the app.

```bash
npm install
npx vitest run
```

- `varar/cart.md` is the spec. Plain Markdown, no keywords.
- `src/varar/cart.steps.ts` binds its sentences to Spana's `connect()` API.
- `global-setup.ts` serves `app/index.html` on port 4173. Remove it and set
  `APP_URL` to test your own app.

Docs: https://spana.antonwester.se/writing-tests/varar/
