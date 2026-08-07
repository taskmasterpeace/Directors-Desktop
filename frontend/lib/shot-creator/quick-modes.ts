/**
 * Quick-mode buttons — ported 1:1 from Palette's Shot Creator
 * (src/features/shot-creator/hooks/usePromptGeneration.ts and
 * constants/recipe-samples.ts). The prompts below are VERBATIM from Palette so
 * both apps produce identical sheets.
 *
 * Each mode is "attach photo(s) → hit the button → Generate":
 * - Wardrobe: extract the outfit from a photo onto the gray mannequin (3 views).
 * - Character: professional character reference sheet from a person photo.
 * - Location: merge 1-10 photos of one place into a master location sheet.
 * - Style: 3x3 style-guide grid extracted from reference image(s).
 */

export type QuickModeKind = 'wardrobe' | 'character' | 'location' | 'style'

/** Palette's system mannequin template (full-body, FRONT/SIDE/BACK). Must be the FIRST reference. */
export const MANNEQUIN_REFERENCE_URL =
  'https://tarohelkwuurakbxjyxm.supabase.co/storage/v1/object/public/templates/system/mannequins/unisex-3view-noruler.jpg'

/** Verbatim WARDROBE_MANNEQUIN_PROMPT from Palette usePromptGeneration.ts. */
export const WARDROBE_MANNEQUIN_PROMPT = `Reference image 1 is a neutral gray articulated mannequin shown in three orthographic views — FRONT, SIDE, BACK — on a clean off-white studio background. Reference image 2 is a photograph of a person wearing an outfit.

TASK: Extract the COMPLETE outfit worn by the person in image 2 and dress the gray mannequin from image 1 in it, shown across all three views (FRONT / SIDE / BACK) with small sans-serif labels above each view.

Capture EVERY item the person is wearing, by category:
- EYEWEAR: glasses / sunglasses worn on the head
- HEADWEAR: hat / cap / beanie / hood, if any
- TOP LAYERS: outerwear (jacket / coat / hoodie) worn over any inner top — keep the layering EXACTLY as worn (e.g. an open jacket over a visible t-shirt) and render both layers
- BOTTOM: pants / jeans / shorts / skirt, plus any belt
- FOOTWEAR: shoes / sneakers / boots, plus socks
- ACCESSORIES: bag / crossbody / jewelry / scarf / watch — drawn ON TOP of the garments, never omitted

Match the exact colors, materials, patterns, prints, distressing, and hardware from image 2.

INFER WHAT YOU CANNOT FULLY SEE: if a garment is partially hidden, cropped out, or ambiguous in the photo — the back of a jacket, the sleeve length, a hemline, footwear not fully visible, the far side of the body — invent a plausible, complete, consistent version of it rather than leaving that region bare or blank. Make a sensible best guess and keep it consistent across all three views.

HARD REQUIREMENTS:
- The clothing is WORN ON the gray mannequin. Show the mannequin ONLY — no human, no real face, no skin, no hair. Keep the mannequin's gray articulated body.
- The garments must be consistent across FRONT, SIDE, and BACK.
- Do NOT copy the person, pose, background, lighting, or framing from image 2 — take ONLY the outfit.
- Studio product-photography lighting, clean off-white background, sharp focus on the wardrobe.
- No purple, no neon. No extra text beyond the FRONT / SIDE / BACK labels.`

/**
 * Character Sheet — Palette's system recipe template with the <<FIELD>> slots
 * turned into visible [FILL IN] markers the user edits in the prompt box.
 */
export const CHARACTER_SHEET_PROMPT = `CHARACTER @[CHARACTER NAME]

Character identity: [DESCRIBE THE CHARACTER]

Face consistency: Keep the person's facial features exactly the same as the reference image. Do not alter face, hairstyle, or body proportions.

Create a professional character reference sheet of this person on a clean white/light gray background.

LAYOUT (Left to Right):

SECTION 1 - FULL BODY VIEWS:
- Large front view with proportion grid lines
- Side profile view
- Back view
- All views on same baseline for height reference
- Below: COLOR PALETTE strip showing skin, hair, eye colors, and main clothing colors

SECTION 2 - EXPRESSIONS & DETAILS:
- Header: "CHARACTER @[CHARACTER NAME]" with description box
- EXPRESSION GRID (2 rows x 3 columns):
  Row 1: Talking-Neutral, Talking-Happy, Talking-Angry
  Row 2: Sad, Surprised, Smug/Confident
- Below: CLOSE-UP DETAILS box for distinctive features
- ACCESSORIES boxes for props/items

SECTION 3 - TALKING VIEWS:
- Profile head shots showing speaking poses
- Additional ACCESSORIES boxes

STYLE: realistic

Clean, production-ready layout. No busy backgrounds.
Consistent lighting and rendering across all views.
Professional character sheet suitable for animation/illustration reference.`

/**
 * Master Location Reference Sheet — Palette's system recipe template with the
 * field slots turned into visible [FILL IN] markers.
 */
export const LOCATION_SHEET_PROMPT = `You are an expert environmental concept artist, architectural analyst, production designer, and photogrammetry specialist.

The attached images (1-10) are multiple photographs — different angles, parts, and details — of the EXACT SAME location: @[LOCATION NAME].
Additional notes: [OPTIONAL NOTES]

Treat every photo as a separate scan of one real place. Cross-reference them all to reconstruct the location as accurately as possible, then merge everything into ONE unified, ultra-clean 16:9 Master Location Reference Sheet.

This is NOT a mood board or a collage. It is a professional environment reference sheet, detailed enough that someone could recreate the location without ever seeing the original photos.

STYLE — COPY THE PHOTOS EXACTLY (MOST IMPORTANT):
- Render every reconstructed view in the EXACT photographic style of the uploaded images: the same medium, lighting quality, color grade, contrast, lens character, grain, and level of realism.
- Do NOT stylize, illustrate, cartoonify, or reinterpret. If the photos are photorealistic, the sheet is photorealistic. Match the real-world look precisely.

REMOVE ALL PEOPLE:
- No people anywhere in the sheet. Reconstruct any surface, furniture, or object a person was blocking, and restore it as if the place had always been empty.

RESOLVE INCONSISTENCIES:
- If two photos disagree, infer the most likely real-world arrangement using perspective, lighting, geometry, and overlapping objects. Infer hidden areas plausibly. Never invent impossible architecture or objects the photos do not support.

Produce ONE 16:9 sheet, cleanly organized with thin panel borders and small sans-serif labels, on a neutral background. Include these panels:
1. HERO VIEW — large perspective reconstruction of the entire location.
2. FLOOR PLAN — simple top-down layout: walls, doors, windows, major furniture, traffic flow.
3. WALL ELEVATIONS — orthographic views of each major wall.
4. CEILING — lighting placement, fixtures, HVAC, beams/skylights, ceiling texture.
5. FLOOR — material, pattern, wear, and transitions.
6. MATERIAL LIBRARY — labeled swatches of the real surfaces (paint, wood, stone, concrete, tile, glass, metal, fabric, carpet, etc.).
7. COLOR PALETTE — 20-40 swatches of the dominant environmental colors.
8. LIGHTING ANALYSIS — primary light sources, sun/natural light direction, color temperature, shadow direction, ambient light and reflections.
9. OBJECT LIBRARY — key objects isolated individually (furniture, fixtures, decor, equipment, signage).
10. ARCHITECTURAL DETAILS — trim, molding, door/window hardware, framing, baseboards, columns, railings, stairs, built-ins.
11. TEXTURE CLOSE-UPS — detailed close-up samples of walls, floor, ceiling, and key materials.
12. ENVIRONMENTAL NOTES — concise labels: approximate age, style, condition, construction quality, and unique characteristics.

Capture the defining details visible in the photos: fixtures, power outlets and switches, HVAC, cameras/alarms/detectors, speakers, cables, signage, branding/logos, and any unique objects.

Museum-quality, highly organized, technical, print-ready reference sheet. Accurate proportions and consistent lighting throughout. No people, no duplicate panels, no hallucinated objects, no missing architectural features.`

/** Verbatim 3x3 style-guide prompt from Palette's style-transfer quick mode. */
export const STYLE_GUIDE_PROMPT = `Create a 9-image grid (3 rows x 3 columns) demonstrating a single visual style applied to different subjects.

Do not render any text in the image — no labels, titles, captions, words, letters, or watermarks. Pure visual content only.

GRID LAYOUT:
Arrange 9 cells in a 3x3 grid. Separate each cell with SOLID BLACK LINES (4-6 pixels wide) for clean extraction.

CRITICAL STYLE EXTRACTION (match the reference image(s) EXACTLY):
Analyze ALL provided reference images collectively to extract the unified visual style:
- Color palette, contrast, saturation, and color temperature
- Rendering approach (painterly, photorealistic, illustrated, 3D, anime, claymation, etc.)
- Line quality and edge treatment (sharp vs soft, clean vs textured)
- Lighting style, shadow behavior, and mood
- Texture and material rendering quality
- Camera language (depth of field, lens feel, framing approach)

CRITICAL: Generate ALL NEW characters and subjects. DO NOT replicate, copy, or reference any specific people, characters, or subjects from the reference images. This style guide demonstrates the STYLE can be applied to entirely different subjects.

THE 9 CELLS (3x3 grid):

Row 1: A dramatic headshot of a new person showing skin and facial detail | A different person in relaxed 3/4 pose showing body and clothing | 2-3 diverse people in conversation or activity together

Row 2: A figure in energetic motion (running, dancing, fighting) | An expressive close-up capturing strong emotion | A close-up of hands interacting with an object

Row 3: An atmospheric indoor environment with props and lighting | A landscape or cityscape establishing shot with depth | A still life of varied materials (metal, glass, fabric, wood)

Every cell must feel like it belongs to the SAME visual world — consistent style language across all 9 cells, with no style drift.`

/** An input the user fills before a quick-mode sheet generates. Its `marker`
 *  is the literal placeholder in the prompt that the value replaces — so the
 *  sheet reads real text instead of "[DESCRIBE THE CHARACTER]". */
export interface QuickModeField {
  key: string
  label: string
  /** The exact placeholder in `prompt` to substitute (all occurrences). */
  marker: string
  placeholder?: string
  multiline?: boolean
  required?: boolean
}

export interface QuickModeConfig {
  kind: QuickModeKind
  label: string
  /** One-line tooltip explaining the flow. */
  hint: string
  /** Image model the mode runs on (Palette parity). */
  modelId: string
  aspectRatio: string
  prompt: string
  /** User-filled fields (Character/Location). Absent/empty = fully automatic
   *  (Wardrobe/Style: attach photo → click → generate). */
  fields?: QuickModeField[]
  /** Extra per-model params sent as modelParams. */
  modelParams?: Record<string, unknown>
  /** Reference URL(s) prepended BEFORE the user's photos (order matters). */
  prependReferenceUrls?: string[]
  /** How many user photos the mode accepts. */
  minPhotos: number
  maxPhotos: number
  /** File-picker title. */
  pickerTitle: string
}

/** Substitute a mode's field values into its prompt. A required field's marker
 *  is replaced by its value; an empty optional field's marker becomes "none"
 *  so the sentence still reads cleanly. */
export function applyQuickModeFields(
  prompt: string,
  fields: QuickModeField[] | undefined,
  values: Record<string, string>,
): string {
  let out = prompt
  for (const f of fields ?? []) {
    const v = (values[f.key] ?? '').trim()
    out = out.split(f.marker).join(v || (f.required ? f.marker : 'none'))
  }
  return out
}

/** Required fields left blank — block generation until filled. */
export function missingQuickModeFields(
  fields: QuickModeField[] | undefined,
  values: Record<string, string>,
): QuickModeField[] {
  return (fields ?? []).filter((f) => f.required && !(values[f.key] ?? '').trim())
}

export const QUICK_MODES: Record<QuickModeKind, QuickModeConfig> = {
  wardrobe: {
    kind: 'wardrobe',
    label: 'Wardrobe',
    hint: 'Outfit photo → mannequin wardrobe sheet (front/side/back)',
    // Palette hardcodes gpt-image-2 at 3:2, low quality by default.
    modelId: 'dp-gpt-image-2',
    aspectRatio: '3:2',
    prompt: WARDROBE_MANNEQUIN_PROMPT,
    modelParams: { quality: 'low' },
    prependReferenceUrls: [MANNEQUIN_REFERENCE_URL], // mannequin FIRST, outfit photo SECOND
    minPhotos: 1,
    maxPhotos: 1,
    pickerTitle: 'Choose an outfit photo',
  },
  character: {
    kind: 'character',
    label: 'Character',
    hint: 'Person photo + name/description → full character reference sheet',
    modelId: 'dp-gpt-image-2',
    aspectRatio: '3:2',
    prompt: CHARACTER_SHEET_PROMPT,
    fields: [
      { key: 'name', label: 'Character name', marker: '[CHARACTER NAME]', required: true, placeholder: 'e.g. Maya' },
      { key: 'description', label: 'Describe the character', marker: '[DESCRIBE THE CHARACTER]', required: true, multiline: true, placeholder: 'age, build, hair, distinctive features, typical clothing…' },
    ],
    modelParams: { quality: 'medium' },
    minPhotos: 1,
    maxPhotos: 1,
    pickerTitle: 'Choose a photo of the character',
  },
  location: {
    kind: 'location',
    label: 'Location',
    hint: '1-10 photos of one place + name → master location sheet',
    modelId: 'dp-nano-banana-2',
    aspectRatio: '16:9',
    prompt: LOCATION_SHEET_PROMPT,
    fields: [
      { key: 'name', label: 'Location name', marker: '[LOCATION NAME]', required: true, placeholder: "e.g. Maya's kitchen" },
      { key: 'notes', label: 'Notes (optional)', marker: '[OPTIONAL NOTES]', multiline: true, placeholder: "time of day, condition, anything the photos don't show…" },
    ],
    minPhotos: 1,
    maxPhotos: 10,
    pickerTitle: 'Choose photos of the location (1-10)',
  },
  style: {
    kind: 'style',
    label: 'Style',
    hint: 'Reference image(s) → 3x3 style guide grid',
    modelId: 'dp-nano-banana-2',
    aspectRatio: '16:9',
    prompt: STYLE_GUIDE_PROMPT,
    minPhotos: 1,
    maxPhotos: 9,
    pickerTitle: 'Choose style reference image(s)',
  },
}
