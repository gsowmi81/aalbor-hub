# Aalbor Hub

Production planning and, from Phase 2, stock control for Aalbor Kitchens, Botany. Replaces Jobman for those two jobs.

- Putting it live (Render, email, domain, backups): [docs/setup.md](docs/setup.md)
- How it's built and how to maintain it: [CLAUDE.md](CLAUDE.md)
- Approved build plan: [docs/build-plan.html](docs/build-plan.html) (phone copy: https://claude.ai/artifact/MNiU6BvSXjJ8dj8GHgw1AW)
- Build brief, 28 Oct 2026: https://claude.ai/artifact/Y6n8ZD3JvPcS8CiHcQuD88
- Approved mock-up: https://claude.ai/artifact/HBbUtp5Vc858fJDH2RnK1K

```
npm install && npm run migrate:dev && npm run dev
npm run typecheck && npm test && npm run build
```
