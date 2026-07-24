---
product: MonoX starter web
audience: developers, platform engineers, and coding agents
surface: public starter application
register: brand
---

# Product context

## Purpose

Prove that a generated MonoX workspace has a working web service and make the platform contract understandable
at a glance. The page is both a health-check target and a compact explanation of how MonoX moves work from
generation to a bounded deployment.

## Users

- Developers evaluating the generated repository before writing product code.
- Platform engineers checking service, container, and deployment conventions.
- Coding agents locating the repository boundaries and the commands they are allowed to run.

## Primary action

Generate a project with the published `create-monox` package. The secondary action opens the canonical source
repository, while the rest of the page explains the architecture, delivery contract, current capability
status, and explicit non-goals.

## Voice

Architectural, dependable, and direct. Use concrete nouns and verbs. Avoid vague AI claims, inflated scale
promises, and copy that could describe any developer tool.

## Design principles

- Show the delivery flow instead of decorating it.
- Keep important information visible without interaction.
- Use a near-black canvas for the developer opening a fresh project during a dim code review. Reserve cobalt
  and amber for actions and operational signals.
- Use logical CSS properties so the layout remains sound in LTR and RTL documents.
- Meet WCAG AA contrast, preserve keyboard focus, and provide a no-motion experience.
- Treat model output as data and describe scaling as a configured, observable ceiling.

## Success criteria

- The page identifies MonoX and its role in one viewport on a laptop.
- The generation, boundary, verification, and deployment stages are immediately scannable.
- The page remains usable at 320 CSS pixels, with zoom, keyboard navigation, and reduced motion enabled.
- No customer data, production identifier, private product copy, or credential is present.
