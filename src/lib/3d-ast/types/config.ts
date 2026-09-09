/**
 * Configuration options for the 3D AST generator
 */
export interface Config {
  /** Parser configuration */
  parser: {
    /** Strict mode for syntax validation */
    strict: boolean;
    /** Allow custom node types */
    allowCustomTypes: boolean;
    /** Default geometry for unspecified nodes */
    defaultGeometry: string;
  };
  /** Layout configuration */
  layout: {
    /** Layout algorithm to use */
    algorithm: 'hierarchical' | 'force-directed' | 'circular' | 'grid';
    /** Spacing between nodes */
    nodeSpacing: number;
    /** Number of layers for hierarchical layout */
    layers: number;
  };

  /** Visual configuration */
  visual: {
    /** Color theme */
    theme: 'dark' | 'light' | 'custom';
    /** Custom color mappings */
    colors: Record<string, string>;
    /** Default material properties */
    material: {
      metalness: number;
      roughness: number;
      opacity: number;
    };
  };

  /** Output configuration */
  output: {
    /** Include debug information */
    debug: boolean;
    /** Optimize for performance */
    optimize: boolean;
    /** Generate additional metadata */
    includeMetadata: boolean;
  };
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Config = {
  parser: {
    strict: false,
    allowCustomTypes: true,
    defaultGeometry: 'cube',
  },
  layout: {
    algorithm: 'hierarchical',
    nodeSpacing: 30.0,
    layers: 3,
  },
  visual: {
    theme: 'dark',
    colors: {
      function: '#4CAF50',
      component: '#2196F3',
      datapath: '#FF9800',
      module: '#9C27B0',
      class: '#F44336',
      interface: '#00BCD4',
      variable: '#FFEB3B',
      constant: '#795548',
      person: '#FFC107',
      boundary: '#E0E0E0',
      junction: '#888888',
    },
    material: {
      metalness: 0.1,
      roughness: 0.7,
      opacity: 0.9,
    },
  },
  output: {
    debug: false,
    optimize: true,
    includeMetadata: true,
  },
};
