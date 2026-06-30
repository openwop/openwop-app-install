# feature.image-gen.agents

The **Image Generator** agent pack (ADR 0115 Phase 6). A persona that drives the
text-to-image node (`core.openwop.ai.image-generate`) through the existing OpenWOP
AI chat — the ADR 0058 "chat-drivability = agent + nodes" pattern. It adds **no new
chat surface**: scope the main chat to `feature.image-gen.agents.default`.

- **Honest-off:** with no image provider wired the node returns
  `host_capability_missing`; the agent says so rather than faking an image.
- **Artifacts:** generated images are returned as host media artifacts, never raw
  bytes in the chat.

The image provider is operator-configured (ADR 0115 Phase 3, `OPENWOP_IMAGE_PROVIDER_*`)
and advertised only when enabled (`imageGenerationAdvertised()`).
