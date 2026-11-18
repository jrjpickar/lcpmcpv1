# LocalCare Props MCP V3 starter

Apply the combined ZIP to the root of the repository from `lcpmcpv1-main.zip`. It includes the Studio and JARVIS agents. The existing dashboard, Netlify functions, MCP tools, and source integrations remain the base. The Studio uses its own endpoint, config schema, and storage adapter, so the patch can be reviewed and merged on a feature branch of the parent MCP once that repository is available.

## Scope

- Studio administrators can relabel and reorder the four existing tabs, reorder and hide six Sales widget groups, and add, edit, reorder, or remove note and KPI modules on any existing tab. KPI modules use the current report and its filters. Preview shows tab labels, visible Sales groups, and rendered modules.
- Administrators can save a draft, explicitly publish, and restore a previous release. The registry keeps the most recent 20 release records. Concurrent updates with a stale revision fail. A published change takes effect for other readers on their next page load. Drafts and release history require the Studio key.
- Preview has no connector calls or executable code. The module schema accepts text and approved KPI identifiers. It does not provide an executable sandbox or run tests against generated code.
- Full widget and page editing, resizing, undo/redo, API and workflow builders, executable extensions, and a performance refactor remain open. See [JARVIS setup](JARVIS.md) for the four LangGraph agents and Groq Free configuration. Executable extensions require isolated workers. Production credentials and Netlify storage behavior require validation on a test deploy. No performance improvement or frame rate was measured.

## Local setup and verification

1. Use Node 22 or later. Run `npm ci`, `npm test`, and `npm run build`.
2. Set `LCP_STUDIO_KEY` to a unique secret of at least 24 characters. For a local session, run `LCP_STUDIO_KEY='your-local-secret-at-least-24-characters' npm run sandbox`. Open the address printed by the server, select Studio, and enter that key. The sandbox uses sample dashboard data and writes configuration to `.lcp-studio-local.json`. Set `LCP_STUDIO_LOCAL_FILE` to use a separate file. Use one sandbox server per file.
3. Choose a Note or KPI, preview it, save the draft, then confirm publication. Open the destination tab or reload to see the result. Use release history to restore a previous version.

The original suite passed 39 tests. The updated local Node suite passed 40, including administrator access, same-origin writes, schema rejection, concurrent writes, draft isolation, persistence on reopen, publication, and rollback. The local build check and standalone sample export passed. See [JARVIS setup](JARVIS.md) for verification of the Netlify-native update.

## Netlify activation

1. Apply the ZIP to a branch based on the original source. Keep existing environment settings. Add a distinct `LCP_STUDIO_KEY` to the Functions environment for the intended deploy context. For a test deploy, use a separate Netlify site for an independent registry.
2. Deploy the updated shell through the existing Netlify workflow. The Studio creates the site-scoped `lcp-studio` Blob store entry on the first write. It needs no external database or migration. The local sandbox adapter is separate.
3. Verify publish and rollback on the test site. Subsequent supported layout and module releases use the registry and require no code deployment.

Netlify persistence uses strong reads and conditional writes. [Netlify Blobs documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
