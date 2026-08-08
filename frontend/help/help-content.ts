/**
 * SINGLE SOURCE OF TRUTH for the Help Center AND Director's Pal.
 *
 * Every user-facing surface in Directors Desktop gets exactly one small
 * HelpSection here. The Help Center renders these as a table-of-contents +
 * one-screen article each (designed to FIT a 16:9 pane without long scrolling).
 * Director's Pal imports the SAME data as its knowledge base, so "how do I…"
 * answers stay in lockstep with the UI — update the app, update it here, and
 * both the docs and the assistant are correct.
 *
 * Coverage rule: 100% of the app must be represented. `HELP_AREAS` is the TOC
 * spine; help-content.test.ts fails if an area has no sections or a `related`
 * link is dangling, guarding against drift as features are added.
 */

// Cropped screenshots — imported (not /public) so vite fingerprints them and
// they resolve under Electron's file:// base './' in packaged builds too.
import homeShot from './shots/home.jpg'
import genSpaceShot from './shots/gen-space.jpg'
import timelineShot from './shots/timeline.jpg'
import directorsPalShot from './shots/directors-pal.jpg'

/** A single control (button/icon) on a surface — shown as an icon chip. */
export interface HelpControl {
  /** lucide-react icon name (PascalCase), resolved by the renderer's icon map. */
  icon: string
  label: string
  desc: string
  /** Optional keyboard shortcut, human-formatted (e.g. "Ctrl+Z"). */
  shortcut?: string
}

/** One small, self-contained help article — sized to fit one 16:9 screen. */
export interface HelpSection {
  /** Stable id — used for deep links (help#id) and Director's Pal citations. */
  id: string
  /** TOC group; must be one of HELP_AREAS. */
  area: HelpArea
  /** Short article title. */
  title: string
  /** lucide-react icon name for the TOC row + header. */
  icon: string
  /** One or two sentences: what it is + why you'd use it. */
  blurb: string
  /** How to reach it in the app (nav path / button / right-click). */
  reach?: string
  /** Terse step-by-step (keep <= 6 so the section fits without scrolling). */
  steps?: string[]
  /** The controls/buttons on this surface, each with its real icon. */
  controls?: HelpControl[]
  /** Optional cropped screenshot asset path (served from /help-shots/…). */
  screenshot?: string
  /** Related section ids (rendered as "See also" chips). */
  related?: string[]
  /** Extra searchable keywords for the TOC filter + Director's Pal retrieval. */
  keywords?: string[]
}

export type HelpArea =
  | 'Getting Started'
  | 'Create'
  | 'Timeline'
  | 'Library'
  | 'Tools'
  | 'Director’s Pal (AI)'
  | 'Settings'

/** TOC order, top to bottom. */
export const HELP_AREAS: HelpArea[] = [
  'Getting Started',
  'Create',
  'Timeline',
  'Library',
  'Tools',
  'Director’s Pal (AI)',
  'Settings',
]

export const HELP_SECTIONS: HelpSection[] = [
  // ═══════════════════════════ Getting Started ════════════════════════════
  {
    id: 'welcome',
    area: 'Getting Started',
    title: 'Welcome to Directors Desktop',
    icon: 'Clapperboard',
    blurb: 'Turn ideas into finished video: generate images and clips, arrange them on a real editing timeline, and let AI help at every step.',
    reach: 'This is the Home screen — the sidebar on the left moves you around.',
    screenshot: homeShot,
    steps: [
      'Pick a Create tool (Music Video, Playground, or Story Stage), or open a project under Edit.',
      'Generate media; results land in your Gallery and the project.',
      'Drag media onto the timeline, then trim, arrange, and export.',
      'Stuck? Click ? (top-right) or press F1, or ask Director’s Pal anywhere.',
    ],
    related: ['sidebar-nav', 'pricing', 'directors-pal-overview'],
    keywords: ['start', 'intro', 'overview', 'first', 'begin', 'home'],
  },
  {
    id: 'sidebar-nav',
    area: 'Getting Started',
    title: 'Sidebar & navigation',
    icon: 'PanelsTopLeft',
    blurb: 'The left sidebar groups everything into Create, Edit (your projects), Library, and Tools.',
    reach: 'Always on the left of the Home screen.',
    controls: [
      { icon: 'Clapperboard', label: 'Music Video', desc: 'Song in → music video out.' },
      { icon: 'Sparkles', label: 'Playground', desc: 'Free-form image & video generation (Gen Space).' },
      { icon: 'Theater', label: 'Story Stage', desc: 'Character-voiced stories onto your timeline.' },
      { icon: 'Image', label: 'Gallery', desc: 'Everything you’ve generated.' },
      { icon: 'UserCircle', label: 'Characters', desc: 'Reusable character identities.' },
      { icon: 'ImageIcon', label: 'References', desc: 'People, places, wardrobe & styles.' },
      { icon: 'NotebookText', label: 'Recipes', desc: 'Saved prompt snippets.' },
      { icon: 'Scissors', label: 'Clip Tool', desc: 'Pull a segment out of any video.' },
    ],
    related: ['welcome'],
    keywords: ['nav', 'menu', 'sidebar', 'where', 'find'],
  },
  {
    id: 'pricing',
    area: 'Getting Started',
    title: 'Points vs. local (free)',
    icon: 'Coins',
    blurb: 'Local engines render free on your own GPU; cloud models spend points ("pts") or use your own API key. Every model shows its cost before you generate.',
    steps: [
      'Models tagged "free (local)" run on your GPU at no cost.',
      'Cloud models (Nano Banana, GPT Image, Seedance) show a pts cost or need a key.',
      'Add keys in Settings → API Keys; your points balance shows on Home.',
    ],
    controls: [
      { icon: 'Cpu', label: 'Local', desc: 'MiniMax H3, LTX 2.3 — free on your GPU.' },
      { icon: 'Coins', label: 'Cloud (pts)', desc: 'Palette models bill points per render.' },
      { icon: 'KeyRound', label: 'Your key', desc: 'Replicate / fal models use your own API key.' },
    ],
    related: ['settings-keys', 'model-status'],
    keywords: ['points', 'pts', 'cost', 'price', 'credits', 'free', 'local', 'gpu'],
  },

  // ═══════════════════════════════ Create ═════════════════════════════════
  {
    id: 'gen-space',
    area: 'Create',
    title: 'Gen Space (Playground)',
    icon: 'Sparkles',
    blurb: 'A single-shot generation workspace: type a prompt, generate, and every result lands in a per-project asset grid you can favorite, foldr, edit, animate, and retake.',
    reach: 'Playground in the sidebar, or the Gen Space tab inside a project.',
    screenshot: genSpaceShot,
    steps: [
      'Pick a mode (Image / Video / Retake) from the MODE dropdown, bottom-left.',
      'Type a prompt (use @ to drop in a character or reference).',
      'Set the model + options on the settings row, then hit Generate.',
    ],
    controls: [
      { icon: 'Image', label: 'MODE', desc: 'Switch Image / Video / Retake.' },
      { icon: 'Wand2', label: 'Enhance', desc: 'AI-improve the prompt (or roll a random one).' },
      { icon: 'BookOpen', label: 'Recipes', desc: 'Insert a saved Location/Wardrobe/Style snippet.' },
      { icon: 'Grid3X3', label: 'Batch', desc: 'Queue many generations at once.' },
    ],
    related: ['gen-image', 'gen-video', 'quick-modes', 'batch', 'asset-grid'],
    keywords: ['playground', 'generate', 'gen space', 'prompt', 'shot creator'],
  },
  {
    id: 'gen-image',
    area: 'Create',
    title: 'Generate images',
    icon: 'ImageIcon',
    blurb: 'Text-to-image and image editing (img2img). Pick a "look" (outcome) rather than a raw model, set size/ratio/quality, and make 1–4 variations.',
    reach: 'Gen Space → MODE → Generate Images.',
    controls: [
      { icon: 'Sparkles', label: 'Look picker', desc: 'Choose an outcome; shows real model + pts.' },
      { icon: 'Pencil', label: 'Edit source', desc: 'Drop an image to edit (img2img); Strength slider.' },
      { icon: 'Monitor', label: 'Resolution', desc: '1080p / 1440p / 2048p.' },
      { icon: 'Frame', label: 'Camera angle', desc: 'Orbit the subject (supported models only).' },
      { icon: 'SlidersHorizontal', label: 'Variations', desc: '1–4 images per generate.' },
      { icon: 'ImagePlus', label: '+ Reference', desc: 'Attach reference images for likeness.' },
    ],
    related: ['gen-space', 'quick-modes', 'gen-video'],
    keywords: ['image', 'img2img', 'edit', 'look', 'variations', 'camera angle', 'quality'],
  },
  {
    id: 'gen-video',
    area: 'Create',
    title: 'Generate video',
    icon: 'Film',
    blurb: 'Text-to-video, image-to-video (first frame), audio-to-video lip-sync, and last-frame-guided clips — local (free) or cloud engines.',
    reach: 'Gen Space → MODE → Generate Videos.',
    controls: [
      { icon: 'Image', label: 'First frame', desc: 'Drop an image to animate from (I2V).' },
      { icon: 'Music', label: 'Audio', desc: 'Attach audio for lip-sync (A2V).' },
      { icon: 'Frame', label: 'Last frame', desc: 'Target the final frame.' },
      { icon: 'Clock', label: 'Duration', desc: 'Preset lengths + an exact-seconds stepper.' },
      { icon: 'Monitor', label: 'Resolution/FPS', desc: '480p/720p local; FPS in API mode.' },
      { icon: 'Layers', label: 'LoRA', desc: 'Local LTX 2.3 style LoRAs.' },
    ],
    related: ['gen-references', 'gen-space', 'clip-tool'],
    keywords: ['video', 't2v', 'i2v', 'a2v', 'lip sync', 'seedance', 'ltx', 'h3', 'duration'],
  },
  {
    id: 'gen-references',
    area: 'Create',
    title: 'Omni references (Seedance 2.0)',
    icon: 'Images',
    blurb: 'Attach up to 9 images, 3 audio clips, and 3 short video clips (≤15s) as references — tagged @Image1 / @Audio1 / @Video1 — to steer a Seedance 2.0 generation.',
    reach: 'Gen Space video mode, shown when the model is Seedance 2.0 / 2.0 Fast.',
    controls: [
      { icon: 'ImageIcon', label: 'Image', desc: 'Pick from Characters + References library.' },
      { icon: 'Music', label: 'Audio', desc: 'Attach an audio reference.' },
      { icon: 'Film', label: 'Clip', desc: 'Attach a video ≤15s (auto length-checked).' },
    ],
    related: ['gen-video', 'clip-tool', 'timeline-regen'],
    keywords: ['reference', 'omni', 'seedance', '@image', '@video', 'caps'],
  },
  {
    id: 'quick-modes',
    area: 'Create',
    title: 'Quick modes (Wardrobe/Character/Location/Style)',
    icon: 'Shirt',
    blurb: 'One-tap Palette recipes: arm a mode, attach photo(s), hit Generate — the model, aspect, and full prompt are applied for you.',
    reach: 'The four toggle buttons in the Gen Space prompt bar.',
    controls: [
      { icon: 'Shirt', label: 'Wardrobe', desc: 'Outfit photo → mannequin sheet (front/side/back).' },
      { icon: 'UserRound', label: 'Character', desc: 'Person photo + name/desc → character sheet.' },
      { icon: 'MapPin', label: 'Location', desc: '1–10 photos + name → master location sheet.' },
      { icon: 'Palette', label: 'Style', desc: 'Reference image(s) → 3×3 style-guide grid.' },
    ],
    related: ['gen-image', 'references', 'recipes'],
    keywords: ['wardrobe', 'character sheet', 'location', 'style guide', 'quick mode', 'mannequin'],
  },
  {
    id: 'recipes',
    area: 'Create',
    title: 'Recipes',
    icon: 'NotebookText',
    blurb: 'Saved reusable prompt snippets for Locations, Wardrobe, and Styles — insert one into your prompt at the caret with a click.',
    reach: 'Recipes button (BookOpen) in the Gen Space prompt bar; manage in the Recipes library.',
    related: ['quick-modes', 'gen-space', 'library-recipes'],
    keywords: ['recipe', 'snippet', 'preset', 'prompt'],
  },
  {
    id: 'retake',
    area: 'Create',
    title: 'Retake a video segment',
    icon: 'Scissors',
    blurb: 'Load a video, scrub the filmstrip, trim a segment to a locked length (15/10/5/3/1s), and regenerate just that piece.',
    reach: 'Gen Space → MODE → Retake, or the Retake action on any video card.',
    controls: [
      { icon: 'Play', label: 'Transport', desc: 'Space=play, ←/→ frame-step, J/K/L shuttle.' },
      { icon: 'Scissors', label: 'Snap', desc: 'Lock the selection to 15/10/5/3/1s.' },
      { icon: 'RefreshCw', label: 'Replace', desc: 'Swap in a different source video.' },
    ],
    related: ['gen-video', 'timeline-clips', 'clip-tool'],
    keywords: ['retake', 'segment', 'trim', 'regenerate', 'filmstrip'],
  },
  {
    id: 'batch',
    area: 'Create',
    title: 'Batch generation',
    icon: 'Grid3X3',
    blurb: 'Queue many generations at once — from a list of prompts, an image→video pipeline, a CSV/JSON import, or a parameter sweep (cross-product).',
    reach: 'Batch button (Grid3X3) in the Gen Space prompt bar. Target: Local GPU or Cloud.',
    controls: [
      { icon: 'Layers', label: 'Prompts→Images', desc: 'One image per prompt line × variations.' },
      { icon: 'Film', label: 'Images→Videos', desc: 'Auto-caption images, then animate all.' },
      { icon: 'List', label: 'List', desc: 'Editable rows of mixed image/video jobs.' },
      { icon: 'FileText', label: 'Import', desc: 'Paste or upload CSV/JSON jobs.' },
      { icon: 'Grid3X3', label: 'Grid Sweep', desc: 'Up to 3 axes → param cross-product.' },
    ],
    related: ['gen-space', 'queue', 'directors-pal-actions'],
    keywords: ['batch', 'bulk', 'sweep', 'pipeline', 'csv', 'many', 'queue'],
  },
  {
    id: 'asset-grid',
    area: 'Create',
    title: 'Asset grid & cards',
    icon: 'LayoutGrid',
    blurb: 'Every generation lands in the grid. Favorite, sort into folders, and use hover actions to edit, animate, save to library, or retake.',
    reach: 'The main area of Gen Space.',
    controls: [
      { icon: 'Heart', label: 'Favorite', desc: 'Star a result; filter to favorites.' },
      { icon: 'FolderInput', label: 'Folders', desc: 'Move cards into bins; rename/dissolve.' },
      { icon: 'Pencil', label: 'Edit', desc: 'Send an image back into image editing.' },
      { icon: 'Film', label: 'Create video', desc: 'Animate an image (I2V).' },
      { icon: 'UserPlus', label: 'Save', desc: 'Save as a Character or Reference.' },
      { icon: 'Download', label: 'Download', desc: 'Save the file out.' },
    ],
    related: ['gen-space', 'gallery', 'characters', 'references'],
    keywords: ['grid', 'card', 'favorite', 'folder', 'bin', 'download', 'preview'],
  },
  {
    id: 'music-video',
    area: 'Create',
    title: 'Music Video (Director)',
    icon: 'Clapperboard',
    blurb: 'Song in → finished, beat-synced music video out. The Director analyzes the song, plans beat-snapped shots, renders each, trims to cuts, and lays the song under the picture. Crash-safe and resumable.',
    reach: 'Music Video in the sidebar.',
    steps: [
      'Pick a Song, write a one-line Concept + a Story/Treatment.',
      'Choose an Artist (their look rides every shot) and a Director style.',
      'Optionally set Wardrobe looks, "Review the plan first", and "Storyboard first".',
      'Pick model + resolution + format, then Make the video.',
    ],
    controls: [
      { icon: 'Music', label: 'Song', desc: 'The track to build to.' },
      { icon: 'UserCircle', label: 'Artist', desc: 'Character whose look rides every shot.' },
      { icon: 'Clapperboard', label: 'Director', desc: 'Style that flavors every shot.' },
      { icon: 'Play', label: 'Make the video', desc: 'Start the resumable build run.' },
    ],
    related: ['music-video-run', 'story-stage', 'timeline-overview'],
    keywords: ['music video', 'director', 'song', 'beat', 'mv', 'shots', 'artist'],
  },
  {
    id: 'music-video-run',
    area: 'Create',
    title: 'Music Video: the build run',
    icon: 'ListChecks',
    blurb: 'The run column steps through Listen → Plan → Frames → Approve → Generate → Assemble → Done. Gates let you edit prompts and approve keyframes before spending.',
    reach: 'Right column after you start a Music Video build.',
    steps: [
      'Listen: the song is analyzed into beats/sections (the Song Map).',
      'Plan (optional): edit every shot’s prompt for free before rendering.',
      'Frames/Approve (optional): review keyframes; mark some to regenerate.',
      'Generate → Assemble → Done, then Open in editor or add as an alt track.',
    ],
    controls: [
      { icon: 'Music', label: 'Song Map', desc: 'Click a section to audition it.' },
      { icon: 'RotateCcw', label: 'Reroll', desc: 'On a finished video, click shots to re-render.' },
      { icon: 'Square', label: 'Cancel', desc: 'Stop an active run (resumable).' },
      { icon: 'Film', label: 'Open in editor', desc: 'Shots as clips, song on audio, sections as markers.' },
    ],
    related: ['music-video', 'timeline-overview'],
    keywords: ['plan', 'storyboard', 'reroll', 'assemble', 'resume', 'stages'],
  },
  {
    id: 'story-stage',
    area: 'Create',
    title: 'Story Stage',
    icon: 'Theater',
    blurb: 'Character-voiced stories from Audio Movie Studio, placed onto your timeline un-mixed — narrator on one lane, each character on their own — ready to edit and score.',
    reach: 'Story Stage in the sidebar.',
    related: ['timeline-overview', 'timeline-tracks', 'directors-pal-overview'],
    keywords: ['story', 'audiobook', 'dramatis', 'narration', 'characters', 'voice'],
  },
  {
    id: 'clip-tool',
    area: 'Create',
    title: 'Clip Tool',
    icon: 'Scissors',
    blurb: 'Pull a segment out of any video (YouTube downloads work), pick up to 15s, and either export it or send it into generation as a Seedance video reference.',
    reach: 'Clip Tool in the sidebar.',
    controls: [
      { icon: 'FolderOpen', label: 'Choose video', desc: 'Load any mp4/mov/mkv/webm.' },
      { icon: 'Sparkles', label: 'Use as reference', desc: 'Splice ≤15s → Playground @Video1.' },
      { icon: 'Scissors', label: 'Export clip', desc: 'Trim to an MP4 file.' },
    ],
    related: ['gen-references', 'retake'],
    keywords: ['clip', 'trim', 'youtube', 'segment', 'reference', 'export'],
  },

  // ═══════════════════════════════ Timeline ═══════════════════════════════
  {
    id: 'timeline-overview',
    area: 'Timeline',
    title: 'The timeline editor',
    icon: 'Clapperboard',
    blurb: 'A real non-linear editor: a menu bar, a left tool rail, a program monitor, a ruler + tracks, and a properties panel. Drag media in, cut it, arrange it, and export.',
    reach: 'Open any project from Home (Edit) or "Open in editor" from a build.',
    screenshot: timelineShot,
    controls: [
      { icon: 'MousePointer2', label: 'Tool rail', desc: 'Select, Blade, Trim tools, Snap, Markers.' },
      { icon: 'Clapperboard', label: 'Program monitor', desc: 'Preview + transport + In/Out.' },
      { icon: 'PanelRight', label: 'Properties', desc: 'Per-clip settings on the right.' },
    ],
    related: ['timeline-menubar', 'timeline-tools', 'timeline-clips', 'timeline-shortcuts'],
    keywords: ['timeline', 'editor', 'nle', 'edit', 'tracks'],
  },
  {
    id: 'timeline-menubar',
    area: 'Timeline',
    title: 'Menu bar (File/Edit/Clip/…)',
    icon: 'Menu',
    blurb: 'The top menu holds project-level actions. Undo/Redo live here (and on the keyboard) — there is no separate undo button.',
    reach: 'Top of the timeline editor.',
    controls: [
      { icon: 'FileText', label: 'File', desc: 'Import media/XML/SRT, Export, Project Settings.', shortcut: 'Ctrl+I / Ctrl+E' },
      { icon: 'Undo2', label: 'Edit', desc: 'Undo/Redo, Cut/Copy/Paste, Insert/Overwrite, Match Frame.', shortcut: 'Ctrl+Z' },
      { icon: 'Scissors', label: 'Clip', desc: 'Split, Duplicate, Flip, Reverse, Mute, Link, Speed.' },
      { icon: 'Layers', label: 'Sequence', desc: 'Add tracks, captions, karaoke, Cut to Beats.' },
      { icon: 'MousePointer2', label: 'Tools/View', desc: 'Pick a tool; zoom & panel layout.' },
    ],
    related: ['timeline-overview', 'timeline-shortcuts'],
    keywords: ['menu', 'file', 'edit', 'undo', 'redo', 'import', 'export', 'captions', 'beats'],
  },
  {
    id: 'timeline-tools',
    area: 'Timeline',
    title: 'Tool rail',
    icon: 'MousePointer2',
    blurb: 'The left rail picks your editing tool and toggles snapping, markers, text, and the properties panel. Zoom is on the keyboard, the View menu, and mouse-wheel.',
    reach: 'The vertical rail on the left edge of the timeline.',
    controls: [
      { icon: 'MousePointer2', label: 'Selection', desc: 'Select / move / drag clips.', shortcut: 'V' },
      { icon: 'Scissors', label: 'Blade', desc: 'Click a clip to cut at the cursor.', shortcut: 'B' },
      { icon: 'ArrowLeftRight', label: 'Trim tools', desc: 'Ripple / Roll / Slip / Slide (flyout).', shortcut: 'R/N/Y/U' },
      { icon: 'Magnet', label: 'Snapping', desc: 'Snap edits to edges.', shortcut: 'S' },
      { icon: 'Flag', label: 'Markers', desc: 'Open the markers panel.' },
      { icon: 'ZoomIn', label: 'Zoom', desc: 'Zoom in/out, fit to view.', shortcut: '= / - / Ctrl+0' },
    ],
    related: ['timeline-overview', 'timeline-shortcuts', 'timeline-markers'],
    keywords: ['tool', 'blade', 'ripple', 'roll', 'slip', 'slide', 'snap', 'zoom', 'toolbar'],
  },
  {
    id: 'timeline-transport',
    area: 'Timeline',
    title: 'Program monitor & transport',
    icon: 'Play',
    blurb: 'Preview the sequence, scrub, set In/Out points, and loop a range. The status-bar transport strip mirrors pro NLE controls.',
    reach: 'Above and below the preview in the timeline editor.',
    controls: [
      { icon: 'Play', label: 'Play / Pause', desc: 'Toggle playback.', shortcut: 'Space' },
      { icon: 'ChevronRight', label: 'Step', desc: 'One frame back/forward.', shortcut: '← / →' },
      { icon: 'Repeat', label: 'Loop In/Out', desc: 'Loop-play the In→Out range.' },
      { icon: 'Expand', label: 'Fullscreen', desc: 'Fullscreen preview.', shortcut: '` / F11' },
    ],
    related: ['timeline-overview', 'timeline-shortcuts'],
    keywords: ['transport', 'play', 'scrub', 'in', 'out', 'monitor', 'preview', 'loop'],
  },
  {
    id: 'timeline-markers',
    area: 'Timeline',
    title: 'Markers',
    icon: 'Flag',
    blurb: 'Drop colored markers with titles and notes on the ruler — the AI reads marker notes, so they double as instructions. Ranged markers cover a span.',
    reach: 'Press M at the playhead, or the Flag button on the tool rail.',
    controls: [
      { icon: 'Flag', label: 'Add marker', desc: 'Marker at the playhead.', shortcut: 'M' },
      { icon: 'Palette', label: 'Color', desc: 'amber / red / green / blue / zinc.' },
      { icon: 'MessageSquare', label: 'Note', desc: 'Freeform note (the AI reads these).' },
    ],
    related: ['timeline-overview', 'agent-bridge'],
    keywords: ['marker', 'flag', 'chapter', 'note', 'range', 'color'],
  },
  {
    id: 'timeline-tracks',
    area: 'Timeline',
    title: 'Tracks & headers',
    icon: 'Rows3',
    blurb: 'Stack video, audio, and subtitle tracks. Each header controls source-patch, lock, output, mute/solo, and height; subtitle tracks add styling.',
    reach: 'Left of each lane; the add-track bar sits at the top of the stack.',
    controls: [
      { icon: 'Plus', label: 'Add track', desc: 'Video / Audio / Subtitle / Adjustment layer.' },
      { icon: 'CircleDot', label: 'Source patch', desc: 'Target track for insert/overwrite edits.' },
      { icon: 'Lock', label: 'Lock', desc: 'Locked clips can’t be edited/deleted.' },
      { icon: 'Eye', label: 'Output', desc: 'Enable/disable a video track’s output.' },
      { icon: 'Volume2', label: 'Mute / Solo', desc: 'Mute or solo audio tracks.' },
    ],
    related: ['timeline-overview', 'timeline-clips', 'story-stage'],
    keywords: ['track', 'lane', 'header', 'lock', 'mute', 'solo', 'subtitle', 'patch'],
  },
  {
    id: 'timeline-clips',
    area: 'Timeline',
    title: 'Clips on the timeline',
    icon: 'Film',
    blurb: 'Clips are draggable blocks with info badges (duration, resolution, speed, REV, muted, FLIP, linked). Generated clips get an on-clip take cluster and a regenerate button.',
    reach: 'The blocks inside each track.',
    controls: [
      { icon: 'ChevronLeft', label: 'Take nav', desc: 'Flip between takes (n/N counter).' },
      { icon: 'RefreshCw', label: 'Regenerate', desc: 'Re-run the shot → a new take.' },
      { icon: 'Film', label: 'Retake section', desc: 'Regenerate a sub-range of a video clip.' },
      { icon: 'GripVertical', label: 'Drag / trim', desc: 'Move the clip or trim its edges.' },
    ],
    related: ['timeline-takes', 'timeline-context-menu', 'timeline-regen', 'timeline-properties'],
    keywords: ['clip', 'badge', 'take', 'regenerate', 'drag', 'trim', 'speed'],
  },
  {
    id: 'timeline-context-menu',
    area: 'Timeline',
    title: 'Right-click a clip',
    icon: 'MousePointerClick',
    blurb: 'The clip context menu is the power surface: clipboard, edit, transform, color labels, and the AI Tools + "Use Frame As…" families.',
    reach: 'Right-click any clip (single or multi-selection) on the timeline.',
    controls: [
      { icon: 'Scissors', label: 'Edit', desc: 'Cut/Copy/Paste, Duplicate, Split.' },
      { icon: 'FlipHorizontal2', label: 'Transform', desc: 'Flip H/V, Reverse, Speed, Mute.' },
      { icon: 'RefreshCw', label: 'AI Tools', desc: 'Regenerate, Replace Person, references, I2V, cast.' },
      { icon: 'Camera', label: 'Use Frame As…', desc: 'Frame → reference / sheet / Gen Space / I2V.' },
      { icon: 'Palette', label: 'Color label', desc: 'Tag clips sharing an asset.' },
    ],
    related: ['timeline-clips', 'timeline-regen', 'timeline-frame-as', 'timeline-takes'],
    keywords: ['context menu', 'right click', 'ai tools', 'replace person', 'cast'],
  },
  {
    id: 'timeline-frame-as',
    area: 'Timeline',
    title: '“Use Frame As…”',
    icon: 'Camera',
    blurb: 'Grab the clip’s current frame and turn it into a reference image, a Character/Location/Wardrobe/Style sheet, a Gen Space edit, or an image-to-video seed.',
    reach: 'Right-click a clip → Use Frame As… (video or image clips).',
    controls: [
      { icon: 'Image', label: 'Reference Image', desc: 'Send the frame to Gen Space as a reference.' },
      { icon: 'Crop', label: 'Crop Frame → Reference', desc: 'Crop a region first (16:9/9:16/1:1/21:9).' },
      { icon: 'Library', label: 'Save to References', desc: 'Store it in your library.' },
      { icon: 'Film', label: 'Image to Video', desc: 'Animate the frame (I2V).' },
    ],
    related: ['timeline-context-menu', 'timeline-crop', 'gen-references', 'quick-modes'],
    keywords: ['frame', 'screenshot', 'reference', 'sheet', 'crop', 'i2v'],
  },
  {
    id: 'timeline-takes',
    area: 'Timeline',
    title: 'Takes',
    icon: 'Layers',
    blurb: 'Every regeneration lands as a new TAKE on the clip — the original is retained. Flip between takes to compare, promote one, or spin a take into its own asset.',
    reach: 'On-clip take arrows, or right-click a take thumbnail (Take menu).',
    controls: [
      { icon: 'Eye', label: 'Set active', desc: 'Make this take the one that plays.' },
      { icon: 'Plus', label: 'Add to timeline', desc: 'Drop the take as a clip.' },
      { icon: 'Copy', label: 'New asset from take', desc: 'Fork the take into its own asset.' },
      { icon: 'Trash2', label: 'Delete take', desc: 'Remove a take (keeps at least one).' },
    ],
    related: ['timeline-clips', 'timeline-regen'],
    keywords: ['take', 'version', 'compare', 'flip', 'retain'],
  },
  {
    id: 'timeline-regen',
    area: 'Timeline',
    title: 'Regenerate with reference',
    icon: 'RefreshCw',
    blurb: '"Redo this shot, but matching THIS." Attach a frame, a crop, or a clip (or build one from another clip) + a note; it renders at the clip’s length and lands as a new take.',
    reach: 'Right-click a video clip → Regenerate with Reference…',
    steps: [
      'Right-click the clip → Regenerate with Reference…',
      'Add references (frame/crop/clip) and an optional note.',
      'Render — the result becomes a new take (the old one stays).',
    ],
    controls: [
      { icon: 'ImagePlus', label: 'Frame/crop', desc: 'Still reference.' },
      { icon: 'Film', label: 'Clip', desc: 'Short video reference (Seedance 2.0).' },
      { icon: 'RefreshCw', label: 'Render take', desc: 'Seedance 2.0 (fal) or Replicate first-frame.' },
    ],
    related: ['timeline-takes', 'timeline-crop', 'gen-references', 'directors-pal-actions'],
    keywords: ['regenerate', 'reference', 'take', 'redo', 'match', 'crop'],
  },
  {
    id: 'timeline-crop',
    area: 'Timeline',
    title: 'Crop a frame or clip region',
    icon: 'Crop',
    blurb: 'Drag a crop box (snap to 16:9 / 9:16 / 1:1 / 21:9 / Free) over a frame to make a cropped reference image, or over a clip to crop the whole segment for a video reference.',
    reach: 'Right-click a clip → Crop Frame/Clip → Reference…',
    related: ['timeline-frame-as', 'timeline-regen', 'gen-references'],
    keywords: ['crop', 'aspect', 'region', 'reference', 'box'],
  },
  {
    id: 'timeline-properties',
    area: 'Timeline',
    title: 'Properties panel',
    icon: 'PanelRight',
    blurb: 'The right panel edits the selected clip: speed, volume, opacity, flip, transitions, start time, and a full color-correction stack.',
    reach: 'The Properties toggle on the tool rail (PanelRight).',
    controls: [
      { icon: 'Gauge', label: 'Speed', desc: 'Retimes the clip (recomputes duration).' },
      { icon: 'Sun', label: 'Color', desc: 'Brightness/contrast/saturation/exposure/temp/tint…' },
      { icon: 'FlipHorizontal2', label: 'Flip', desc: 'Flip horizontal / vertical.' },
      { icon: 'Contrast', label: 'Transitions', desc: 'In/out transition + duration.' },
    ],
    related: ['timeline-clips', 'timeline-context-menu'],
    keywords: ['properties', 'color', 'speed', 'opacity', 'transition', 'metadata'],
  },
  {
    id: 'timeline-transcript',
    area: 'Timeline',
    title: 'Transcript (Descript-style)',
    icon: 'Mic',
    blurb: 'Transcribe a clip, click a word to seek, edit words, correct with a real script, ripple-delete spans, make captions, and turn selected words into generation prompts.',
    reach: 'The Transcript panel for a selected clip with audio.',
    controls: [
      { icon: 'Mic', label: 'Transcribe', desc: 'Word-level transcript of the clip.' },
      { icon: 'FileCheck2', label: 'Script', desc: 'Paste the real script to align timing.' },
      { icon: 'Scissors', label: 'Ripple delete', desc: 'Cut a selected span (silence-snapped).' },
      { icon: 'Wand2', label: 'Words → prompt', desc: 'Turn a selection into an image/video prompt.' },
    ],
    related: ['timeline-clips', 'directors-pal-perception'],
    keywords: ['transcript', 'descript', 'caption', 'words', 'seek', 'script', 'subtitles'],
  },
  {
    id: 'timeline-shortcuts',
    area: 'Timeline',
    title: 'Keyboard shortcuts',
    icon: 'Keyboard',
    blurb: 'Fully remappable, with LTX / Premiere / DaVinci / Avid presets. J/K/L shuttle; hold K to frame-step. Open the editor to customize (drag actions onto keys).',
    reach: 'Menu bar → Edit → Keyboard Shortcuts… (or Help menu).',
    controls: [
      { icon: 'MousePointer2', label: 'Tools', desc: 'V select · B blade · R/N/Y/U trims.' },
      { icon: 'Play', label: 'Transport', desc: 'Space play · ←/→ step · J/K/L shuttle.' },
      { icon: 'Scissors', label: 'Edit', desc: 'Ctrl+Z undo · B split · Del delete · I/O in/out.' },
      { icon: 'Flag', label: 'Mark', desc: 'M add marker (fixed).' },
    ],
    related: ['timeline-tools', 'settings-shortcuts'],
    keywords: ['shortcut', 'keyboard', 'hotkey', 'preset', 'premiere', 'davinci', 'avid'],
  },
  {
    id: 'timeline-assets',
    area: 'Timeline',
    title: 'Assets & timelines panel',
    icon: 'LayoutGrid',
    blurb: 'The left panel holds this project’s media (in bins) up top and its timelines (sequences) below. Import media, sort into bins, and drag onto tracks.',
    reach: 'Left column of the editor; drag the split handle to rebalance.',
    controls: [
      { icon: 'Upload', label: 'Import media', desc: 'Add video/image/audio to the project.' },
      { icon: 'FolderPlus', label: 'Create bin', desc: 'Group assets; drag cards into it.' },
      { icon: 'Layers', label: 'Takes', desc: 'Multi-take assets show a take stepper.' },
      { icon: 'Film', label: 'Timelines', desc: 'Add/switch/rename/duplicate sequences.' },
    ],
    related: ['timeline-overview', 'timeline-clips', 'timeline-takes'],
    keywords: ['assets', 'bin', 'import', 'media', 'timelines', 'sequence', 'panel'],
  },
  {
    id: 'timeline-monitors',
    area: 'Timeline',
    title: 'Clip Viewer & 3-point editing',
    icon: 'MonitorPlay',
    blurb: 'Double-click an asset to open the Clip Viewer beside the program monitor, set In/Out on the source, patch a target track, then Insert (,) or Overwrite (.) — pro 3-point editing.',
    reach: 'Double-click any asset; toggle via View → Show/Hide Clip Viewer.',
    controls: [
      { icon: 'SkipBack', label: 'Mark In/Out', desc: 'Set source range (I / O).' },
      { icon: 'CircleDot', label: 'Patch track', desc: 'Choose the destination track.' },
      { icon: 'Plus', label: 'Insert / Overwrite', desc: 'Drop the source edit (, / .).' },
    ],
    related: ['timeline-transport', 'timeline-tracks', 'timeline-shortcuts'],
    keywords: ['source', 'clip viewer', 'three point', 'insert', 'overwrite', 'monitor'],
  },
  {
    id: 'timeline-gap',
    area: 'Timeline',
    title: 'Fill a gap with AI',
    icon: 'SquareDashedBottomCode',
    blurb: 'Click an empty gap on a video track to fill it with a generated image or video — using the surrounding frames as context and an optional prompt.',
    reach: 'Click an empty gap on a video track → the gap popover → Fill.',
    related: ['timeline-clips', 'gen-video', 'directors-pal-actions'],
    keywords: ['gap', 'fill', 'generate', 'empty', 'inpaint'],
  },
  {
    id: 'timeline-replace-person',
    area: 'Timeline',
    title: 'Replace Person',
    icon: 'UserRoundCog',
    blurb: 'Swap the person in a video clip for a character from your library (or an image), keeping the motion — lands as a new take. Requires consent and shows the points cost.',
    reach: 'Right-click a video clip → Replace Person…',
    related: ['timeline-regen', 'characters', 'timeline-takes'],
    keywords: ['replace', 'person', 'swap', 'face', 'character', 'animate'],
  },
  {
    id: 'timeline-export',
    area: 'Timeline',
    title: 'Export & import',
    icon: 'Download',
    blurb: 'Export a finished video (H.264/ProRes/VP9), optionally burning in subtitles, or package an FCP7/FCPXML for Premiere/DaVinci. Import timelines (XML/EDL) and subtitles (SRT) too.',
    reach: 'File menu → Export/Import; Ctrl+E to export.',
    controls: [
      { icon: 'Film', label: 'Export Video', desc: 'MP4 / MOV / WebM at your resolution & FPS.' },
      { icon: 'Package', label: 'Export Package', desc: 'FCPXML for Premiere / DaVinci.' },
      { icon: 'FileUp', label: 'Import XML', desc: 'Bring in a timeline (with media relink).' },
      { icon: 'FileDown', label: 'Subtitles (SRT)', desc: 'Import/export subtitle files.' },
    ],
    related: ['timeline-menubar', 'timeline-overview'],
    keywords: ['export', 'import', 'render', 'mp4', 'prores', 'fcpxml', 'srt', 'premiere'],
  },
  {
    id: 'project-settings',
    area: 'Timeline',
    title: 'Project settings, Story & Cast',
    icon: 'FolderCog',
    blurb: 'Set the project name and asset-save folder, and keep a Story & Cast: source-of-truth story docs plus a map of story character names to your Characters library (so the AI casts consistently).',
    reach: 'File menu → Project Settings…',
    controls: [
      { icon: 'FolderOpen', label: 'Asset folder', desc: 'Where renders are saved.' },
      { icon: 'BookOpen', label: 'Story docs', desc: 'Script / lyrics / notes as ground truth.' },
      { icon: 'UserRound', label: 'Cast map', desc: 'Link story names → library characters.' },
    ],
    related: ['characters', 'story-stage', 'timeline-overview'],
    keywords: ['project', 'settings', 'story', 'cast', 'save folder', 'speakers'],
  },

  // ═══════════════════════════════ Library ════════════════════════════════
  {
    id: 'gallery',
    area: 'Library',
    title: 'Gallery',
    icon: 'Image',
    blurb: 'Every image and video you’ve generated, paginated and filterable — local outputs plus (when connected) your Director’s Palette cloud gallery.',
    reach: 'Gallery in the sidebar.',
    related: ['asset-grid', 'characters', 'references'],
    keywords: ['gallery', 'outputs', 'history', 'assets', 'library'],
  },
  {
    id: 'characters',
    area: 'Library',
    title: 'Characters',
    icon: 'UserCircle',
    blurb: 'Reusable character identities (name, role, description, reference images). Drop a character into any prompt with @name to keep a face consistent.',
    reach: 'Characters in the sidebar; save one from any image card.',
    related: ['references', 'gen-image', 'music-video'],
    keywords: ['character', 'identity', 'likeness', 'cast', '@'],
  },
  {
    id: 'references',
    area: 'Library',
    title: 'References',
    icon: 'ImageIcon',
    blurb: 'Your library of People, Places, Wardrobe, and Styles — the building blocks quick modes and generations pull from. Organized by category.',
    reach: 'References in the sidebar; save from any card or a timeline frame.',
    related: ['quick-modes', 'characters', 'timeline-frame-as'],
    keywords: ['reference', 'people', 'places', 'wardrobe', 'style', 'library'],
  },
  {
    id: 'library-recipes',
    area: 'Library',
    title: 'Recipes library',
    icon: 'NotebookText',
    blurb: 'Manage the saved Location / Wardrobe / Style prompt snippets that the Recipes picker inserts while you write a prompt.',
    reach: 'Recipes in the sidebar.',
    related: ['recipes', 'quick-modes'],
    keywords: ['recipe', 'snippet', 'library', 'manage'],
  },

  // ══════════════════════════════════ Tools ═══════════════════════════════
  {
    id: 'wildcards',
    area: 'Tools',
    title: 'Wildcards',
    icon: 'Braces',
    blurb: 'Named lists you drop into prompts (e.g. __location__) that expand to random or drilled-down values — great for variety across a batch.',
    reach: 'Wildcards in the sidebar.',
    related: ['prompt-library', 'batch'],
    keywords: ['wildcard', 'variable', 'expand', 'random', 'variety'],
  },
  {
    id: 'prompt-library',
    area: 'Tools',
    title: 'Prompt Library',
    icon: 'BookOpen',
    blurb: 'Save, tag, search, and reuse prompts. Track which ones you use most so your best prompts are always one click away.',
    reach: 'Prompt Library in the sidebar.',
    related: ['wildcards', 'gen-space'],
    keywords: ['prompt', 'library', 'save', 'tag', 'reuse'],
  },
  {
    id: 'model-status',
    area: 'Tools',
    title: 'Model status & downloads',
    icon: 'HardDriveDownload',
    blurb: 'See which local models are installed and download missing ones, with live progress, speed, and ETA. Local models are what make free generation possible.',
    reach: 'The model-status badge in the top bar; also Settings → Models.',
    related: ['pricing', 'settings-models'],
    keywords: ['models', 'download', 'local', 'install', 'gpu', 'status'],
  },
  {
    id: 'queue',
    area: 'Tools',
    title: 'Render queue',
    icon: 'ListChecks',
    blurb: 'Generations run as background jobs so you can keep working. The Playground badge shows how many are rendering/queued; jobs run on a GPU slot (local) and an API slot (cloud) in parallel.',
    reach: 'The pulsing count on Playground; batch submits land here too.',
    controls: [
      { icon: 'ListPlus', label: 'Submit', desc: 'Each generate/batch enqueues one or more jobs.' },
      { icon: 'Loader2', label: 'Status', desc: 'Live progress, phase, and ETA per job.' },
      { icon: 'X', label: 'Cancel', desc: 'Stop a queued or running job.' },
    ],
    related: ['batch', 'gen-space', 'directors-pal-actions'],
    keywords: ['queue', 'jobs', 'background', 'render', 'slot', 'pending'],
  },
  {
    id: 'lora-browser',
    area: 'Tools',
    title: 'LoRAs',
    icon: 'Layers',
    blurb: 'Search CivitAI, download, import, and thumbnail style LoRAs for local LTX 2.3 video — then pick one from the video model’s LoRA dropdown.',
    reach: 'The LoRA dropdown in Gen Space video mode (local LTX 2.3).',
    related: ['gen-video'],
    keywords: ['lora', 'civitai', 'style', 'ltx', 'download'],
  },

  // ══════════════════════════ Director’s Pal (AI) ═════════════════════════
  {
    id: 'directors-pal-overview',
    area: 'Director’s Pal (AI)',
    title: 'Meet Director’s Pal',
    icon: 'Bot',
    blurb: 'A chat assistant you can open anywhere. Ask it how to use the app, or tell it what to make — it can actually do the work, not just describe it.',
    reach: 'Click the Director’s Pal bubble (bottom-right) from any screen.',
    screenshot: directorsPalShot,
    steps: [
      'Ask a question ("how do I add captions?") → it answers from this Help.',
      'Give it a task ("generate 4 rooftop shots") → it queues the work.',
      'Point at the timeline ("what’s on clip 3?") → it looks, then answers.',
    ],
    related: ['directors-pal-actions', 'directors-pal-perception', 'agent-bridge'],
    keywords: ['chat', 'assistant', 'ai', 'bot', 'help', 'pal', 'copilot'],
  },
  {
    id: 'directors-pal-actions',
    area: 'Director’s Pal (AI)',
    title: 'What Director’s Pal can do',
    icon: 'Wand2',
    blurb: 'It reaches the same endpoints you do — generate, batch, and edit on your behalf — and every timeline change is a normal undo step.',
    controls: [
      { icon: 'ImagePlus', label: 'Generate images', desc: 'Single or a batch queued at once.' },
      { icon: 'Film', label: 'Generate video', desc: 'Text/image-to-video via the queue.' },
      { icon: 'ListPlus', label: 'Batch queue', desc: 'Line up many jobs in one ask.' },
      { icon: 'Scissors', label: 'Edit the timeline', desc: 'Move, trim, delete, mark, caption.' },
      { icon: 'RefreshCw', label: 'Regenerate a clip', desc: 'Redo a shot to match a reference → new take.' },
    ],
    related: ['directors-pal-overview', 'agent-bridge', 'batch', 'timeline-regen'],
    keywords: ['actions', 'generate', 'batch', 'queue', 'edit', 'endpoints'],
  },
  {
    id: 'directors-pal-perception',
    area: 'Director’s Pal (AI)',
    title: 'How it “sees” your timeline',
    icon: 'Eye',
    blurb: 'When you reference a clip it can’t read as text, Director’s Pal grabs a few frames and captions them — so it understands what’s on screen before it answers or acts.',
    steps: [
      'Drop a video on the timeline and ask about it.',
      'Director’s Pal extracts frames + captions the clip in the background.',
      'It uses what it "saw" to answer, or to caption/edit/regenerate for you.',
    ],
    related: ['directors-pal-overview', 'timeline-transcript'],
    keywords: ['see', 'vision', 'caption', 'perceive', 'frames', 'screenshot'],
  },
  {
    id: 'agent-bridge',
    area: 'Director’s Pal (AI)',
    title: 'The agent bridge (external AIs)',
    icon: 'Plug',
    blurb: 'The same actions Director’s Pal uses are exposed over a local bridge + MCP server, so any AI (e.g. Claude) can read your timeline and edit it — as one undo step, with every result reported back.',
    steps: [
      'The app publishes a compact table-of-contents of the open production.',
      'An AI submits bounded actions (move/trim/delete/mark/caption/generate/regenerate).',
      'Each action applies through your undo stack and reports applied/rejected.',
    ],
    related: ['directors-pal-actions', 'timeline-markers'],
    keywords: ['mcp', 'agent', 'bridge', 'api', 'automation', 'claude'],
  },

  // ═══════════════════════════════ Settings ═══════════════════════════════
  {
    id: 'settings-keys',
    area: 'Settings',
    title: 'API keys',
    icon: 'KeyRound',
    blurb: 'Connect Replicate, fal, OpenRouter/Gemini, and your Director’s Palette account. Keys unlock cloud models; OpenRouter powers prompt enhance + AI captioning.',
    reach: 'Settings (gear, top-right) → API Keys.',
    controls: [
      { icon: 'KeyRound', label: 'Replicate', desc: 'Cloud image + Seedance 1.5 video.' },
      { icon: 'KeyRound', label: 'fal', desc: 'Seedance 2.0 video (references/lip-sync).' },
      { icon: 'KeyRound', label: 'OpenRouter', desc: 'Prompt enhance + vision captions.' },
    ],
    related: ['pricing', 'settings-overview'],
    keywords: ['api', 'key', 'replicate', 'fal', 'openrouter', 'gemini', 'connect'],
  },
  {
    id: 'settings-models',
    area: 'Settings',
    title: 'Models',
    icon: 'HardDriveDownload',
    blurb: 'Install and manage the local model pack (what enables free, on-GPU generation), scan custom video models, and pick text-encoder options.',
    reach: 'Settings → Models.',
    related: ['model-status', 'pricing'],
    keywords: ['models', 'download', 'local', 'encoder', 'settings'],
  },
  {
    id: 'settings-shortcuts',
    area: 'Settings',
    title: 'Keyboard shortcut editor',
    icon: 'Keyboard',
    blurb: 'Remap any action: pick a preset (LTX/Premiere/DaVinci/Avid), drag actions onto a visual keyboard, or record a key. Save custom presets.',
    reach: 'Edit menu → Keyboard Shortcuts…',
    related: ['timeline-shortcuts'],
    keywords: ['shortcut', 'remap', 'preset', 'keyboard', 'customize'],
  },
  {
    id: 'settings-overview',
    area: 'Settings',
    title: 'Settings & logs',
    icon: 'Settings',
    blurb: 'The gear (top-right) opens app settings; the file icon opens backend logs. Use logs when a generation misbehaves or the engine restarts.',
    reach: 'Top-right controls, on any screen except Home.',
    controls: [
      { icon: 'Settings', label: 'Settings', desc: 'Keys, models, sync, preferences.' },
      { icon: 'FileText', label: 'Logs', desc: 'What the engine printed (for troubleshooting).' },
      { icon: 'HelpCircle', label: 'Help', desc: 'This Help Center (F1).' },
    ],
    related: ['settings-keys', 'settings-models', 'settings-shortcuts'],
    keywords: ['settings', 'logs', 'preferences', 'troubleshoot', 'gear'],
  },
]

/** All section ids, for link validation. */
export const HELP_SECTION_IDS: string[] = HELP_SECTIONS.map((s) => s.id)

/** Sections grouped by area, in HELP_AREAS order (empty areas omitted at render). */
export function helpSectionsByArea(): { area: HelpArea; sections: HelpSection[] }[] {
  return HELP_AREAS.map((area) => ({
    area,
    sections: HELP_SECTIONS.filter((s) => s.area === area),
  })).filter((g) => g.sections.length > 0)
}

/** Lightweight search across title/blurb/keywords/controls for the TOC filter. */
export function searchHelp(query: string): HelpSection[] {
  const q = query.trim().toLowerCase()
  if (!q) return HELP_SECTIONS
  return HELP_SECTIONS.filter((s) => {
    const hay = [
      s.title,
      s.blurb,
      s.reach ?? '',
      ...(s.keywords ?? []),
      ...(s.controls?.flatMap((c) => [c.label, c.desc]) ?? []),
      ...(s.steps ?? []),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}

/**
 * Compact knowledge dump for Director's Pal — the whole Help as terse text it
 * can ground answers on. Kept small (title + blurb + reach + steps) so it fits a
 * system prompt without the control-level detail.
 */
export function helpKnowledgeText(): string {
  return HELP_SECTIONS.map((s) => {
    const lines = [`## ${s.title}  [${s.area}]  (id: ${s.id})`, s.blurb]
    if (s.reach) lines.push(`Where: ${s.reach}`)
    if (s.steps?.length) lines.push('Steps: ' + s.steps.map((x, i) => `${i + 1}) ${x}`).join(' '))
    return lines.join('\n')
  }).join('\n\n')
}
