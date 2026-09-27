/**
 * ADR 0488 D3 — the SEED tutorials: the shipped English library, and the
 * DEGRADED-MODE FLOOR that keeps `/tutorials` alive when the `entities` kernel
 * is off (it defaults OFF; `/tutorials` is deliberately always-on).
 *
 * GENERATED, NOT HAND-COPIED. This content was mechanically dumped from the
 * frontend's authored modules (`features/tutorials/content/*.ts`) so the two
 * cannot disagree at birth, and `tutorial-seed-drift.test.ts` pins them so they
 * cannot drift afterwards. P4/P5 retires the frontend copy; until then the
 * ratchet is what makes the temporary duplication safe.
 *
 * `seedVersion` is CODE-OWNED (never editable through a tenant surface). Bump it
 * when editing a tutorial here and the seeder refreshes every tenant row that
 * has NOT been customized (`ext.customizedAt`), leaving tenant edits intact.
 */

export type TutorialCategory = 'getting-started' | 'build' | 'marketing' | 'commerce';
export type TutorialDifficulty = 'beginner' | 'intermediate' | 'advanced';

/** One `run:{chainId,nodeId}` binding — ADR 0488 D1, the narrative→spine seam.
 *  The narrative NEVER contains an action; the chain NEVER contains a paragraph. */
export interface TutorialRunBinding {
  chainId: string;
  nodeId?: string;
}

export interface SeededTutorialStep {
  id: string;
  title: string;
  content: unknown[];
  /** Legacy whole-walkthrough link (ADR 0490). Superseded per-step by `run`. */
  walkthroughId?: string;
  run?: TutorialRunBinding;
}

export interface SeededTutorialPhase {
  number: number;
  title: string;
  description?: string;
  goal?: string;
  outcome?: string;
  /** ADR 0488 D2 — this phase's sub-chain, run by "Show me this phase". */
  chainId?: string;
  steps: SeededTutorialStep[];
}

export interface SeededTutorial {
  id: string;
  category: TutorialCategory;
  title: string;
  description: string;
  hero: { title: string; subtitle: string };
  goal?: string;
  learningObjectives?: string[];
  prerequisites?: string[];
  surfaces?: string[];
  requiresSeed?: string;
  estimatedMinutes?: number;
  difficulty?: TutorialDifficulty;
  phases: SeededTutorialPhase[];
  seedVersion: string;
}

/** Bump a tutorial's `seedVersion` when you edit it (see the module docblock). */
export const SEED_TUTORIALS: SeededTutorial[] = [
  {
    "id": "connect-your-ai",
    "category": "getting-started",
    "title": "Connect Your AI",
    "description": "Bring your own AI provider key, pick your models, and have your first grounded conversation with an agent.",
    "hero": {
      "title": "Connect Your AI",
      "subtitle": "From a fresh workspace to your first agent conversation"
    },
    "goal": "Set up the AI layer everything else builds on: your own provider credential (BYOK), model selection, and the one chat that drives every AI feature in the product.",
    "learningObjectives": [
      "Understand the managed free tier vs bring-your-own-key",
      "Add a provider API key on the Keys page",
      "Choose models on the Models page",
      "Start a conversation and talk to an agent"
    ],
    "prerequisites": [
      "An API key from your AI provider (or use the managed tier to start)"
    ],
    "estimatedMinutes": 15,
    "difficulty": "beginner",
    "surfaces": [
      "/keys",
      "/models"
    ],
    "phases": [
      {
        "number": 1,
        "title": "Managed Tier vs Your Own Key",
        "goal": "Know which tier you are on and why BYOK matters.",
        "outcome": "You know where your AI calls run and who pays for them.",
        "steps": [
          {
            "id": "1.1",
            "title": "The two tiers",
            "content": [
              {
                "type": "feature-grid",
                "items": [
                  {
                    "label": "Managed tier",
                    "desc": "Try-it-free calls through the host’s pooled key — capped, great for a first look"
                  },
                  {
                    "label": "BYOK",
                    "desc": "Your own provider credential — your models, your budgets, held host-side and never exposed to the browser"
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "info",
                "title": "Keys never leave the server",
                "body": "BYOK credentials are stored host-side and used server-to-provider. They never appear in page source, chat transcripts, or exports."
              }
            ]
          }
        ]
      },
      {
        "number": 2,
        "chainId": "tutorial.connect-your-ai.phase-2",
        "title": "Add Your Provider Key",
        "goal": "Register the credential.",
        "outcome": "The chat unlocks with your own provider.",
        "steps": [
          {
            "id": "2.1",
            "title": "The Keys page",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open the **Keys** page and add your provider’s API key (OpenAI, Anthropic, Google — whichever you use)."
                  },
                  {
                    "text": "If a chat ever answers with **“this provider requires a BYOK credential”**, this page is where you fix it."
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "number": 3,
        "chainId": "tutorial.connect-your-ai.phase-3",
        "title": "Pick Your Models",
        "goal": "Choose which model answers each turn.",
        "outcome": "Chat turns route to the model you chose.",
        "steps": [
          {
            "id": "3.1",
            "title": "The Models page",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open **Models** — choose which model answers chat turns, and see which models your team rates highest."
                  },
                  {
                    "text": "You can change the model per conversation later; this sets the default."
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "number": 4,
        "chainId": "tutorial.connect-your-ai.phase-4",
        "title": "Your First Conversation",
        "goal": "Talk to the product.",
        "outcome": "A saved conversation with a real answer.",
        "steps": [
          {
            "id": "4.1",
            "title": "Say hello",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open the **Chat** tab and ask something real — conversations persist, stream live, and can run workflows."
                  },
                  {
                    "text": "Pick an **agent** to scope the conversation: agents bring their own tools and personas (the Funnel Architect, the Promotions Manager, your workspace’s own roster)."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "tip",
                "title": "One chat, everywhere",
                "body": "Every “talk to AI” surface in the product is the SAME chat, scoped to an agent — skills you learn here apply everywhere."
              }
            ]
          }
        ]
      },
      {
        "number": 5,
        "title": "Where AI Shows Up Next",
        "goal": "See the surface area you just unlocked.",
        "outcome": "You know what to try next.",
        "steps": [
          {
            "id": "5.1",
            "title": "The map",
            "content": [
              {
                "type": "feature-grid",
                "items": [
                  {
                    "label": "Workflows",
                    "desc": "AI nodes inside durable, replayable automations"
                  },
                  {
                    "label": "Agents",
                    "desc": "Personas with tools, schedules, and memory"
                  },
                  {
                    "label": "Campaign Studio",
                    "desc": "AI-generated briefs, channel content, and ads"
                  },
                  {
                    "label": "Funnels",
                    "desc": "The Funnel Architect proposes conversion experiments"
                  }
                ]
              },
              {
                "type": "checklist",
                "items": [
                  {
                    "label": "Provider key added"
                  },
                  {
                    "label": "Default model chosen"
                  },
                  {
                    "label": "First conversation saved"
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    "seedVersion": "1.5.0"
  },
  {
    "id": "campaign-studio-first-brief",
    "category": "marketing",
    "title": "Campaign Studio: Your First Brief",
    "description": "Create a campaign brief — the container for product, persona, and channels — then turn it into a running campaign. Watch it happen, or follow along.",
    "hero": {
      "title": "Your First Campaign Brief",
      "subtitle": "Read the steps, or press “Show me” and let the app drive"
    },
    "goal": "Learn the brief → campaign flow in Campaign Studio, with the option to watch a guided walkthrough perform each step.",
    "learningObjectives": [
      "Open a new campaign brief",
      "Name and create it",
      "Find where a brief becomes a running campaign"
    ],
    "prerequisites": [
      "Campaign Studio enabled",
      "Walkthroughs enabled (for “Show me”)"
    ],
    "estimatedMinutes": 5,
    "difficulty": "beginner",
    "surfaces": [
      "/campaign-studio"
    ],
    "phases": [
      {
        "number": 1,
        "chainId": "walkthrough.campaign-studio.first-brief",
        "title": "Brief → Campaign",
        "goal": "Create your first brief and see where it becomes a campaign.",
        "outcome": "You have a brief, and you know where campaigns come from.",
        "steps": [
          {
            "id": "1.1",
            "title": "Create a brief, guided",
            "content": [
              {
                "type": "callout",
                "variant": "info",
                "title": "Press “Show me”",
                "body": "The guided walkthrough opens a new brief, pauses for you to name it, creates it, verifies it exists, and lands on the Campaigns tab — each step spotlighted and narrated. Prefer to do it yourself? The steps below are the same flow by hand."
              },
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open Campaign Studio and press “New brief”."
                  },
                  {
                    "text": "Name the brief (tip: start it with “[Walkthrough]” so it’s easy to find later), then Create."
                  },
                  {
                    "text": "Open the Campaigns tab — that’s where a confirmed brief becomes a running campaign."
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    "seedVersion": "1.5.0"
  },
  {
    "id": "build-your-first-funnel",
    "category": "marketing",
    "title": "Build Your First Sales Funnel",
    "description": "From a blank workspace to a published, measured, A/B-tested sales funnel — pages, routing, checkout, upsells, analytics, and AI optimization.",
    "hero": {
      "title": "Build Your First Sales Funnel",
      "subtitle": "From zero to a revenue-measured funnel in 10 phases"
    },
    "goal": "This hands-on guide walks you through the full funnel stack: design the pages, assemble and publish the funnel, route visitors, take payment, measure every step, run an experiment, and let the Funnel Architect propose the next improvement.",
    "learningObjectives": [
      "Design and publish funnel pages in the CMS Page Builder",
      "Assemble ordered funnel steps and control the visitor path with routing rules",
      "Publish a funnel to a shareable public URL",
      "Sell through the storefront with affiliate attribution, order bumps, and one-click upsells",
      "Read per-step analytics (views, completions, conversion, revenue)",
      "Run an honest 50/50 challenger experiment on a step",
      "Use the Funnel Architect agent and the optimization chain to improve conversion"
    ],
    "prerequisites": [
      "A workspace where you hold the editor or owner role",
      "Admin access to feature toggles (or ask your administrator)"
    ],
    "estimatedMinutes": 45,
    "difficulty": "beginner",
    "surfaces": [
      "/funnels"
    ],
    "phases": [
      {
        "number": 1,
        "title": "Turn On the Funnel Stack",
        "description": "Funnels ship OFF by default — flip the toggles once per workspace.",
        "goal": "Enable the features this walkthrough uses.",
        "outcome": "Funnels appears in your sidebar; the commerce surfaces are ready for the selling phases.",
        "steps": [
          {
            "id": "1.1",
            "title": "Enable Funnels (and E-Commerce)",
            "run": {
              "chainId": "walkthrough.feature-toggles.list"
            },
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open **Admin → Feature toggles**."
                  },
                  {
                    "text": "Turn on **Funnels** — the multi-step funnel builder this tutorial is about."
                  },
                  {
                    "text": "Turn on **E-Commerce** too if you want the selling phases (6–7); Funnels recommends it but runs without it."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "info",
                "title": "Where things live",
                "body": "Funnels compose surfaces you may already use: pages come from the CMS Page Builder, payments ride Commerce + Stripe, analytics land on the CDP event spine. Nothing in this tutorial creates a second copy of those systems."
              }
            ]
          },
          {
            "id": "1.2",
            "title": "Know the map",
            "content": [
              {
                "type": "feature-grid",
                "items": [
                  {
                    "label": "Funnels",
                    "desc": "Ordered steps, each serving one of your CMS pages"
                  },
                  {
                    "label": "CMS Page Builder",
                    "desc": "Where every step’s page is designed and published"
                  },
                  {
                    "label": "Storefront",
                    "desc": "Public checkout at /store — bumps, refs, one-click upsells"
                  },
                  {
                    "label": "Analytics",
                    "desc": "Per-step views, completions, conversion, and revenue"
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "number": 2,
        "title": "Design Your Pages",
        "description": "A funnel step serves a published CMS page — build three of them.",
        "goal": "Create and publish the landing, offer, and thank-you pages.",
        "outcome": "Three published pages ready to become funnel steps.",
        "steps": [
          {
            "id": "2.1",
            "title": "Create the three pages",
            "run": {
              "chainId": "walkthrough.cms.pages"
            },
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open the **CMS** and create a page called **Landing** — your hook: headline, the promise, one call-to-action."
                  },
                  {
                    "text": "Create **Offer** — the sales pitch: what they get, proof, price, one buy button."
                  },
                  {
                    "text": "Create **Thanks** — the confirmation: what happens next, and (later) your upsell copy."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "tip",
                "title": "One job per page",
                "body": "Every funnel step should have exactly one call-to-action. If a page tries to do two things, split it into two steps — steps are cheap, confused visitors are not."
              }
            ]
          },
          {
            "id": "2.2",
            "title": "Publish each page",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open each page and hit **Publish**. Publishing is the serving gate: a funnel can reference a draft page, but the public step 404s until the page is published."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "info",
                "title": "Honest serving",
                "body": "If you later unpublish a step’s page, that step becomes unavailable to the public (a clean 404) — the funnel never leaks draft content."
              }
            ]
          }
        ]
      },
      {
        "number": 3,
        "title": "Assemble the Funnel",
        "description": "Order the pages into a path.",
        "goal": "Create the funnel and bind each step to a page.",
        "outcome": "A draft funnel: Landing → Offer → Thanks.",
        "steps": [
          {
            "id": "3.1",
            "title": "Create the funnel",
            "run": {
              "chainId": "walkthrough.funnels.list"
            },
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open **Funnels** in the sidebar, pick your workspace, name it (e.g. **Summer Launch**), and hit **Create funnel**."
                  },
                  {
                    "text": "The URL slug is derived from the name (summer-launch) — it becomes the public path, and it locks while the funnel is published."
                  }
                ]
              }
            ]
          },
          {
            "id": "3.2",
            "title": "Add and order the steps",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "In the funnel editor, **Add step** three times: a **Landing** step → your Landing page, a **Sales** step → Offer, a **Thank you** step → Thanks."
                  },
                  {
                    "text": "Use the up/down arrows to reorder; **Save steps** when the path reads top-to-bottom."
                  },
                  {
                    "text": "The **Edit page** link on any step deep-links straight into the Page Builder — content edits never leave the funnel context."
                  }
                ]
              },
              {
                "type": "checklist",
                "items": [
                  {
                    "label": "Three steps, in order"
                  },
                  {
                    "label": "Every step bound to a published page"
                  },
                  {
                    "label": "Steps saved"
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "number": 4,
        "title": "Publish and Share",
        "description": "Make it live and hand out the entry URL.",
        "goal": "Publish the funnel and open the public entry.",
        "outcome": "A live funnel any visitor can walk.",
        "steps": [
          {
            "id": "4.1",
            "title": "Publish the funnel",
            "run": {
              "chainId": "walkthrough.publishing.settings"
            },
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Hit **Publish** on the funnel. Publishing validates the path: at least one step, and every step’s page must still exist — a broken path fails loudly here, never silently in front of a visitor."
                  },
                  {
                    "text": "The editor now shows the **public entry URL** — open it: your Landing page serves, wrapped with the funnel’s step position."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "info",
                "title": "Visitor privacy",
                "body": "Funnel analytics only track visitors who carry a consented visitor key (the same consent gate as the analytics beacon). Anonymous visitors walk the funnel untracked — by design."
              }
            ]
          },
          {
            "id": "4.2",
            "title": "Optional: your own domain",
            "content": [
              {
                "type": "prose",
                "text": "With the Custom domains feature, a funnel can serve on your own hostname (pages.your-brand.com): register the hostname, prove ownership with a DNS TXT record, and your operator attaches the TLS certificate at the load balancer. The domain is pinned to your workspace’s public content only — fail-closed."
              }
            ]
          }
        ]
      },
      {
        "number": 5,
        "title": "Route Your Visitors",
        "description": "The path is sequential by default — rules make it conditional.",
        "goal": "Understand sequential flow and add an outcome rule.",
        "outcome": "Declined offers skip straight to the thank-you page.",
        "steps": [
          {
            "id": "5.1",
            "title": "How routing works",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "With no rules, completing step N serves step N+1 — and past the last step the funnel reports **complete**."
                  },
                  {
                    "text": "A step can carry **routing rules**: the first rule whose conditions match decides the next step. Conditions today: the reported **outcome** (accepted / declined) and **UTM parameters** on the visitor’s link."
                  }
                ]
              }
            ]
          },
          {
            "id": "5.2",
            "title": "Add a declined-skips-ahead rule",
            "content": [
              {
                "type": "prose",
                "text": "Routing rules are authored through the API (or by the Funnel Architect agent) in this release — the visual rule editor is on the roadmap. To send a declined offer straight to the thank-you step, update the Sales step with:"
              },
              {
                "type": "code",
                "language": "json",
                "code": "{\n  \"steps\": [\n    { \"stepId\": \"landing\", \"kind\": \"landing\", \"pageId\": \"<landing-page-id>\" },\n    { \"stepId\": \"offer\", \"kind\": \"sales\", \"pageId\": \"<offer-page-id>\",\n      \"routing\": [ { \"when\": { \"outcome\": \"declined\" }, \"goto\": \"thanks\" } ] },\n    { \"stepId\": \"thanks\", \"kind\": \"thankyou\", \"pageId\": \"<thanks-page-id>\" }\n  ]\n}"
              },
              {
                "type": "callout",
                "variant": "tip",
                "title": "Timers belong to journeys",
                "body": "Funnel rules decide per-visitor, per-click. Anything time-based — abandonment nudges, follow-up sequences — belongs to Campaign Journeys, which can trigger off the funnel’s own events."
              }
            ]
          }
        ]
      },
      {
        "number": 6,
        "title": "Add Commerce",
        "description": "Turn the offer into revenue.",
        "goal": "Create the product and sell it through the public storefront.",
        "outcome": "Orders carry your funnel’s fingerprint, so revenue shows up per step.",
        "steps": [
          {
            "id": "6.1",
            "title": "Create the product",
            "run": {
              "chainId": "walkthrough.commerce.catalog"
            },
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "In **E-Commerce**, create the product your Offer page sells (name, price, currency). Digital products need no inventory."
                  },
                  {
                    "text": "Point your Offer page’s buy button at the public storefront (/store/<your-workspace>) or embed a product grid section from the Page Builder."
                  }
                ]
              }
            ]
          },
          {
            "id": "6.2",
            "title": "Attribution: the funnel stamp and affiliate refs",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "A checkout that carries the funnel stamp (funnelId + stepId) ties the order to your funnel — that’s how the analytics phase shows **revenue per step**."
                  },
                  {
                    "text": "Affiliate links: create an affiliate with a code in E-Commerce, share links carrying **ref=CODE** — a real code attributes the order and accrues commission at payment; junk codes are silently ignored."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "info",
                "title": "Order bumps",
                "body": "The checkout accepts bump add-ons priced into the SAME single charge, with honest line-item provenance. Bump offers on the checkout page come from your Recommendations placements."
              }
            ]
          }
        ]
      },
      {
        "number": 7,
        "title": "One-Click Upsells",
        "description": "The post-purchase moment is your highest-intent traffic.",
        "goal": "Understand the consent-first one-click chain.",
        "outcome": "You know exactly what to enable — and what stays a human decision.",
        "steps": [
          {
            "id": "7.1",
            "title": "How the chain works",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "At checkout, a buyer can **explicitly consent** (an unticked checkbox) to save their payment method for one-click offers."
                  },
                  {
                    "text": "After payment, your Thanks/upsell step can offer one more product — an accept charges the saved method **without re-entering card details**, creating a child order linked to the original."
                  },
                  {
                    "text": "A declined card routes to your downsell; a bank challenge (SCA) falls back to a normal confirm — the chain never silently drops a sale."
                  }
                ]
              }
            ]
          },
          {
            "id": "7.2",
            "title": "The operator gate",
            "content": [
              {
                "type": "callout",
                "variant": "warning",
                "title": "Money movement is opt-in",
                "body": "One-click charging ships DISABLED. Your operator enables it (OPENWOP_COMMERCE_OFFSESSION_ENABLED) only after the compliance review for your markets — until then the consent checkbox and chain endpoints exist but no off-session charge is ever made."
              }
            ]
          }
        ]
      },
      {
        "number": 8,
        "title": "Measure Every Step",
        "description": "The funnel is only as good as its weakest step.",
        "goal": "Read the per-step analytics honestly.",
        "outcome": "You can name your weakest step with numbers, not vibes.",
        "steps": [
          {
            "id": "8.1",
            "title": "The analytics table",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open your funnel and find **Analytics**: per step you get **Views**, **Completions**, **Conversion**, **Orders**, and **Revenue**."
                  },
                  {
                    "text": "Rollups rebuild on a schedule; **Rebuild now** forces a fresh recompute after a test session."
                  }
                ]
              },
              {
                "type": "feature-grid",
                "items": [
                  {
                    "label": "Views",
                    "desc": "Consented visitors who saw the step"
                  },
                  {
                    "label": "Completions",
                    "desc": "Visitors who advanced past it"
                  },
                  {
                    "label": "Conversion",
                    "desc": "Completions ÷ views — the number to fix"
                  },
                  {
                    "label": "Revenue",
                    "desc": "Paid orders stamped to the step (refunds subtract)"
                  }
                ]
              }
            ]
          },
          {
            "id": "8.2",
            "title": "Trust the numbers",
            "content": [
              {
                "type": "callout",
                "variant": "info",
                "title": "Honest by construction",
                "body": "Analytics derive from the event spine and stamped orders on every rebuild — canceled orders drop out, refunds subtract, deleted funnels sweep their history. The table also states its event window, so very old traffic aging out is disclosed, never hidden."
              }
            ]
          }
        ]
      },
      {
        "number": 9,
        "title": "Experiment",
        "description": "Opinions argue; splits decide.",
        "goal": "Run a 50/50 challenger against your weakest step.",
        "outcome": "A running experiment with verdicts you can trust.",
        "steps": [
          {
            "id": "9.1",
            "title": "Start the split",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Build a **challenger page** in the Page Builder (change ONE thing — the headline, the price framing) and publish it."
                  },
                  {
                    "text": "In the funnel’s **Step experiments** panel, pick the weak step, pick the challenger, and **Start 50/50 split**."
                  },
                  {
                    "text": "Consented visitors are assigned stickily — the same visitor always sees the same variant; anonymous visitors see the original."
                  }
                ]
              }
            ]
          },
          {
            "id": "9.2",
            "title": "Read the verdict honestly",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Results show per-variant visitors, completions, and conversion, plus a significance verdict (95%)."
                  },
                  {
                    "text": "Below 30 visitors per variant the verdict honestly reads **needs more visitors** — never over-read a small sample."
                  },
                  {
                    "text": "**Stop** the experiment when significance lands; if the challenger won, make its page the step’s page."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "tip",
                "title": "One variable at a time",
                "body": "A challenger that changes five things tells you nothing when it wins. Change one element per split; run the next split for the next element."
              }
            ]
          }
        ]
      },
      {
        "number": 10,
        "title": "Optimize with AI",
        "description": "The Funnel Architect reads your numbers and proposes the next move.",
        "goal": "Get a grounded optimization proposal.",
        "outcome": "A prioritized, evidence-based next experiment — proposed by AI, decided by you.",
        "steps": [
          {
            "id": "10.1",
            "title": "Ask the Funnel Architect",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open the chat and talk to the **Funnel Architect** agent: it can list your funnels, read per-step stats, draft new funnels, and propose step changes."
                  },
                  {
                    "text": "Or run the **Funnel Step Optimization Proposal** workflow chain against your funnel — it reads the definition + stats and returns the weakest step, concrete page changes to test, and the exact experiment to start."
                  }
                ]
              }
            ]
          },
          {
            "id": "10.2",
            "title": "You stay in charge",
            "content": [
              {
                "type": "callout",
                "variant": "info",
                "title": "Agents propose, humans dispose",
                "body": "Everything the AI authors stays a DRAFT: it cannot publish a funnel, start or stop an experiment, or touch pricing. The proposal chain is read-only by construction. Publishing to the public web is always a human clicking a button."
              },
              {
                "type": "checklist",
                "items": [
                  {
                    "label": "Funnel published and shared"
                  },
                  {
                    "label": "Revenue attributed per step"
                  },
                  {
                    "label": "First experiment running"
                  },
                  {
                    "label": "First AI proposal reviewed"
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    "seedVersion": "1.5.0"
  },
  {
    "id": "open-your-storefront",
    "category": "commerce",
    "title": "Open Your Storefront",
    "description": "Create products, share your public store, take a real order, apply promotions, and handle a refund — the commerce loop end to end.",
    "hero": {
      "title": "Open Your Storefront",
      "subtitle": "From first product to first refund"
    },
    "goal": "Walk the whole commerce loop: catalog → public storefront → order → promotion → refund → the one-read revenue summary.",
    "learningObjectives": [
      "Create products with prices, variants, and inventory",
      "Share the public storefront and take a guest order",
      "Stack a promotion on top of your prices",
      "Mark orders paid, fulfil them, and issue a refund",
      "Read the revenue summary"
    ],
    "prerequisites": [
      "The E-Commerce feature enabled (Admin → Feature toggles)",
      "Optional: a Stripe key for live card capture"
    ],
    "estimatedMinutes": 25,
    "difficulty": "beginner",
    "surfaces": [
      "/commerce"
    ],
    "phases": [
      {
        "number": 1,
        "title": "Build the Catalog",
        "goal": "Products with honest prices and stock.",
        "outcome": "A sellable catalog.",
        "steps": [
          {
            "id": "1.1",
            "title": "Create products",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open **E-Commerce** and create a product: type (physical / digital / service), name, price, currency."
                  },
                  {
                    "text": "Physical products carry **inventory** — orders reserve stock at creation and release it if payment never lands."
                  },
                  {
                    "text": "Variants (size, color) carry their own SKU and optional price."
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "number": 2,
        "title": "Open the Public Store",
        "goal": "A shareable storefront.",
        "outcome": "Guests can browse and buy.",
        "steps": [
          {
            "id": "2.1",
            "title": "The storefront link",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Your workspace’s public storefront lives at **/store/<workspace>** — share it, or link your funnel’s offer page straight to it."
                  },
                  {
                    "text": "Guest checkout creates the order and a CRM contact from the buyer’s email (deduped)."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "info",
                "title": "Keyless is honest",
                "body": "Without a Stripe key the checkout runs in demo mode: the order exists, honestly unpaid. With a key, buyers get a real hosted card checkout and the webhook flips the order paid."
              }
            ]
          }
        ]
      },
      {
        "number": 3,
        "title": "Promote",
        "goal": "A rule-based discount on top of your prices.",
        "outcome": "A live promotion that applies itself at checkout.",
        "steps": [
          {
            "id": "3.1",
            "title": "Create a promotion",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Open **Promotions** and create one — a cart threshold (“10% over $110”), a product discount, or a budget-capped loss-leader."
                  },
                  {
                    "text": "Promotions compute a discount **on top of** resolved prices at checkout and snapshot onto the order — refunds and reports stay explainable."
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "number": 4,
        "title": "Orders, Fulfilment, Refunds",
        "goal": "Run the order lifecycle.",
        "outcome": "A paid, fulfilled, partially-refunded order — all auditable.",
        "steps": [
          {
            "id": "4.1",
            "title": "The order lifecycle",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "Orders move **pending → paid → fulfilled**; cancelling a pending order releases its stock."
                  },
                  {
                    "text": "With Stripe configured, refunds are REAL — full or partial; the order tracks the cumulative refunded amount."
                  }
                ]
              },
              {
                "type": "callout",
                "variant": "warning",
                "title": "Money verification",
                "body": "A payment only flips an order paid after the amount and currency verify against the order — a mismatched webhook is rejected loudly, never silently accepted."
              }
            ]
          }
        ]
      },
      {
        "number": 5,
        "title": "Read the Numbers",
        "goal": "One read for the whole picture.",
        "outcome": "You know your GMV, AOV, and top products.",
        "steps": [
          {
            "id": "5.1",
            "title": "The revenue summary",
            "content": [
              {
                "type": "instructions",
                "items": [
                  {
                    "text": "The commerce **reports summary** gives GMV, average order value, top products, coupon usage, and low-stock warnings in one read."
                  },
                  {
                    "text": "Selling through a funnel? Per-step revenue lands in the funnel’s own analytics too (the Build Your First Sales Funnel tutorial, phase 8)."
                  }
                ]
              },
              {
                "type": "checklist",
                "items": [
                  {
                    "label": "Product created"
                  },
                  {
                    "label": "Storefront order placed"
                  },
                  {
                    "label": "Promotion applied"
                  },
                  {
                    "label": "Refund issued"
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    "seedVersion": "1.5.0"
  },
  {
    "id": "model-your-first-part",
    "category": "build",
    "title": "Model Your First Part",
    "description": "Create a CAD model, size a solid precisely, learn the orbit view, and finish with materials, a dimension, and the AI modeler.",
    "hero": {
      "title": "Model Your First Part",
      "subtitle": "From an empty canvas to a dimensioned, material-real solid"
    },
    "goal": "Learn the CAD editor end to end: solids and precise properties, 3D navigation with the view cube, the closed material catalog, dimensioning with tolerances, and the in-editor CAD Modeler.",
    "learningObjectives": [
      "Create a CAD model and add solids",
      "Set exact dimensions in the property panel",
      "Navigate in 3D with the orbit view and the view cube",
      "Apply a library material and annotate a dimension",
      "Drive a change with the CAD Modeler and undo it"
    ],
    "prerequisites": [
      "The CAD feature enabled",
      "An AI provider connected (BYOK or managed) — the CAD Modeler creates the model you edit"
    ],
    "estimatedMinutes": 15,
    "difficulty": "beginner",
    "surfaces": ["/cad"],
    "phases": [
      {
        "number": 1,
        "title": "Solids and the 3D view",
        "goal": "Create a model, size a solid exactly, and learn to look at it from every side.",
        "outcome": "A box with real dimensions you can inspect from any angle.",
        "steps": [
          {
            "id": "1.1",
            "title": "Create a model",
            "content": [
              { "type": "instructions", "items": [
                { "text": "Open the chat and ask the CAD Modeler for a starting shape — for example “model a 40×30×20mm bracket”." },
                { "text": "It renders a real model and answers with a card; press “Open in editor” on that card to land in the CAD editor." },
                { "text": "Name the model in the toolbar (something like “Bracket” beats “Untitled model” later)." }
              ] },
              { "type": "callout", "variant": "info", "title": "There is no CAD list — and that is deliberate", "body": "The CAD editor is deep-link only: you reach a model from the chat card that made it, or from a link someone shares. There is no CAD entry in the sidebar to hunt for. A CAD model is a canvas document — the solid list on the left, the property panel on the right, the live preview in the centre — and everything you change is undoable from the toolbar history." }
            ]
          },
          {
            "id": "1.2",
            "title": "Size the box precisely",
            "content": [
              { "type": "instructions", "items": [
                { "text": "Select the box in the solid list." },
                { "text": "In the property panel, set Width, Height, and Depth to exact values — the preview updates as you type." },
                { "text": "Set the model’s Units in the document properties (mm, cm, m, or in) so the numbers mean what you intend." }
              ] }
            ]
          },
          {
            "id": "1.3",
            "title": "Orbit, and the view cube",
            "content": [
              { "type": "instructions", "items": [
                { "text": "Switch to the 3D view and drag to orbit — or focus the view and use the arrow keys." },
                { "text": "Use the view cube in the corner: click a face to snap Front, Top, or Right; the arrows step 90°; the home button returns to the ¾ view." }
              ] },
              { "type": "callout", "variant": "info", "title": "The cube never lies", "body": "The view cube is drawn with the same rotation as the model, so it always shows the true orientation — if the cube says Top, you are looking at the top." }
            ]
          }
        ]
      },
      {
        "number": 2,
        "title": "Materials, dimensions, and the AI modeler",
        "goal": "Make the part real: a material, an annotated dimension, and an AI-driven change you can undo.",
        "outcome": "A material-real, dimensioned part — and you have seen the CAD Modeler edit it live.",
        "steps": [
          {
            "id": "2.1",
            "title": "Apply a material",
            "content": [
              { "type": "instructions", "items": [
                { "text": "With the box selected, open Material in the property panel and pick from the catalog — the swatch shows the colour before you commit." },
                { "text": "Fine-tune Metallic and Roughness (0–1) and watch the shading change in the 3D view." }
              ] }
            ]
          },
          {
            "id": "2.2",
            "title": "Annotate a dimension",
            "content": [
              { "type": "instructions", "items": [
                { "text": "Add a linear dimension from the Dimensions collection and point it at your box." },
                { "text": "Pick the Axis (it is required — the editor won’t offer an empty choice) and, if you need one, a tolerance: symmetric asks for one value, asymmetric and limit for two." }
              ] },
              { "type": "callout", "variant": "info", "title": "Values are derived", "body": "Dimension values are measured from the model — annotate the geometry and the number stays true when the geometry changes." }
            ]
          },
          {
            "id": "2.3",
            "title": "Ask the CAD Modeler",
            "content": [
              { "type": "instructions", "items": [
                { "text": "Press “Ask the CAD Modeler” in the toolbar and try an example prompt — the assistant reads THIS model first, then renders validated parametric solids into it." },
                { "text": "Watch the change land in the live view. Not what you wanted? Undo reverts it like any other edit." }
              ] },
              { "type": "callout", "variant": "info", "title": "One chat, everywhere", "body": "The drawer is the same chat that powers every AI feature here — same provider key, same history, same interrupts — scoped to the CAD Modeler agent." }
            ]
          }
        ]
      }
    ],
    "seedVersion": "1.1.0"
  }
];
