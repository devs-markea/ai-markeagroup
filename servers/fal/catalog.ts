// ---------------------------------------------------------------------------
// Curated model catalog (search_models / recommend_model)
// ---------------------------------------------------------------------------

export const CATALOG = [
  { id: "fal-ai/flux/dev",        name: "FLUX.1 Dev",           tags: ["text-to-image", "creative", "artistic", "general", "image"] },
  { id: "fal-ai/flux/schnell",    name: "FLUX.1 Schnell",        tags: ["text-to-image", "fast", "quick", "prototype", "image"] },
  { id: "fal-ai/flux-pro",        name: "FLUX Pro",              tags: ["text-to-image", "professional", "high-quality", "commercial", "image"] },
  { id: "fal-ai/flux-realism",    name: "FLUX Realism",          tags: ["text-to-image", "photorealistic", "photo", "portrait", "realistic", "image"] },
  { id: "fal-ai/stable-diffusion-xl", name: "Stable Diffusion XL", tags: ["text-to-image", "illustration", "stylized", "sdxl", "image"] },
  { id: "fal-ai/aura-flow",       name: "AuraFlow",              tags: ["text-to-image", "art", "painting", "creative", "image"] },
  { id: "fal-ai/kling-video/v1.6/pro/text-to-video", name: "Kling Video Pro", tags: ["text-to-video", "video", "animation", "cinematic"] },
  { id: "fal-ai/minimax-video",   name: "MiniMax Video",         tags: ["text-to-video", "video", "short-video"] },
  { id: "fal-ai/cogvideox-5b",    name: "CogVideoX-5B",          tags: ["text-to-video", "video", "realistic"] },
  { id: "fal-ai/whisper",         name: "Whisper",               tags: ["speech-to-text", "transcription", "audio", "stt"] },
  { id: "fal-ai/imageutils/rembg", name: "Remove Background",   tags: ["image-editing", "background-removal", "rembg"] },
  { id: "fal-ai/esrgan",          name: "ESRGAN Upscaler",       tags: ["image-upscaling", "upscale", "enhance", "super-resolution"] },
  { id: "fal-ai/controlnet-sdxl", name: "ControlNet SDXL",       tags: ["text-to-image", "controlnet", "pose", "depth", "guided"] },
  { id: "fal-ai/ip-adapter-face-id", name: "IP-Adapter FaceID", tags: ["image-to-image", "face", "portrait", "identity"] },
] as const;

export type CatalogModel = (typeof CATALOG)[number];
