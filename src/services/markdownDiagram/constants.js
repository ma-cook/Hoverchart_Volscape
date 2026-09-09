/**
 * Shared constants for MarkdownDiagramService.
 * These are exported as named values so method modules can import them
 * without creating circular dependencies on the class itself.
 */

// Node type constants
export const NODE_TYPE_COMPONENT = 'component';
export const NODE_TYPE_FUNCTION = 'function';
export const NODE_TYPE_STORE = 'store';
export const NODE_TYPE_SERVICE = 'service';
export const NODE_TYPE_LIBRARY = 'library';
export const NODE_TYPE_UTILITY = 'utility';
export const NODE_TYPE_DATAPATH = 'datapath';
export const NODE_TYPE_HANDLER = 'handler';
export const NODE_TYPE_CONTROL = 'control';
export const NODE_TYPE_STATE = 'state';
export const NODE_TYPE_DATA = 'data';
export const NODE_TYPE_HOOK = 'hook';
export const NODE_TYPE_MODULE = 'module';
export const NODE_TYPE_CLASS = 'class';
export const NODE_TYPE_INTERFACE = 'interface';
export const NODE_TYPE_VARIABLE = 'variable';
export const NODE_TYPE_CONSTANT = 'constant';
export const NODE_TYPE_PERSON = 'person';
export const NODE_TYPE_BOUNDARY = 'boundary';
export const NODE_TYPE_JUNCTION = 'junction';

// Object type constants
export const OBJECT_TYPE_CUBE = 'cube';
export const OBJECT_TYPE_DODECAHEDRON = 'dodecahedron';
export const OBJECT_TYPE_TETRAHEDRON = 'tetrahedron';
export const OBJECT_TYPE_OCTAHEDRON = 'octahedron';
export const OBJECT_TYPE_SPHERE = 'sphere';

// UI component identifiers
export const UI_COMPONENTS = [
  'HeaderInput',
  'FaceTextInput',
  'TextObjectUI',
  'TextStyleUIContainer',
];

// Magic number constants
export const MAX_RECURSION_DEPTH = 15;
export const BASE_DODECAHEDRON_SIZE = 10;
export const BASE_DODECAHEDRON_RADIUS = 10;
export const DEFAULT_CAMERA_DISTANCE = 100;
export const SPACING_BETWEEN_COMPONENTS = 200;
export const DEFAULT_CUBE_SIZE = 5;
export const DEFAULT_SPHERE_SIZE = 4;
export const DEFAULT_CONTAINER_SIZE = 50;
export const MIN_SCALE_FACTOR = 1.0;
export const DESIRED_GAP = 8;
export const JUNCTION_MARKER_SCALE = 0.35;

// ── Dynamic group container support ──────────────────────────────────────────

/** Rotating colour palette for dynamically-discovered group containers. */
export const GROUP_CONTAINER_COLORS = [
  '#4CAF50', // green
  '#2196F3', // blue
  '#FF9800', // orange
  '#9C27B0', // purple
  '#F44336', // red
  '#00BCD4', // cyan
  '#795548', // brown
  '#607D8B', // blue-grey
  '#E91E63', // pink
  '#3F51B5', // indigo
  '#009688', // teal
  '#CDDC39', // lime
];

/** Human-friendly names for well-known node types. */
const GROUP_DISPLAY_NAMES = {
  function: 'Utility Modules',
  hook: 'Hooks',
  service: 'Services',
  store: 'Stores',
  backend: 'Backend',
  library: 'Libraries',
  utility: 'Utilities',
  handler: 'Handlers',
  control: 'Controls',
  state: 'State',
  data: 'Data',
  worker: 'Workers',
  shader: 'Shaders',
  module: 'Modules',
  class: 'Classes',
  interface: 'Interfaces',
  variable: 'Variables',
  constant: 'Constants',
  person: 'People',
};

/**
 * Return a user-facing display name for a group key.
 * Falls back to capitalising the key + " Modules".
 */
export function getGroupDisplayName(groupKey) {
  return (
    GROUP_DISPLAY_NAMES[groupKey] ||
    `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Modules`
  );
}

/** Pick a colour from the rotating palette for the given group index. */
export function getGroupColor(index) {
  return GROUP_CONTAINER_COLORS[index % GROUP_CONTAINER_COLORS.length];
}
