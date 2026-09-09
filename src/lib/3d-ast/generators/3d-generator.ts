import { MermaidParser } from '../parser/mermaid-parser';
import { ASTBuilder } from '../parser/ast-builder';
import { Graph } from '../models/graph';
import { Config, DEFAULT_CONFIG } from '../types/config';
import { AST3DGraph } from '../types/ast';

/**
 * Main 3D AST Generator class
 */
export class AST3DGenerator {
  private parser: MermaidParser;
  private builder: ASTBuilder;
  private config: Config;

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.parser = new MermaidParser();
    this.builder = new ASTBuilder(this.config);
  }

  /**
   * Generate 3D AST Graph from Merfolk syntax
   */
  generate(input: string): Graph {
    // Parse the input
    const parsedGraph = this.parser.parse(input);

    // Build the 3D graph
    const graph = this.builder.build(parsedGraph);

    return graph;
  }

  /**
   * Generate and return serializable format
   */
  generateJSON(input: string): AST3DGraph {
    const graph = this.generate(input);
    return graph.toJSON();
  }

  /**
   * Parse input without building (useful for validation)
   */
  parseOnly(input: string) {
    return this.parser.parse(input);
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<Config>): void {
    this.config = { ...this.config, ...newConfig };
    this.builder = new ASTBuilder(this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): Config {
    return { ...this.config };
  }

  /**
   * Validate input syntax
   */
  validate(input: string): { valid: boolean; errors: string[]; warnings: string[] } {
    try {
      const parsed = this.parser.parse(input);
      const errors: string[] = [];
      const warnings: string[] = [];

      // Check for duplicate node IDs — warn and skip, the builder handles
      // duplicates gracefully (Map.set overwrites with last definition) so
      // there is no reason to reject the entire diagram.
      const seenIds = new Set<string>();
      const dedupedNodes: typeof parsed.nodes = [];
      for (const node of parsed.nodes) {
        if (seenIds.has(node.id)) {
          warnings.push(`Duplicate node ID: ${node.id} — skipping duplicate`);
        } else {
          seenIds.add(node.id);
          dedupedNodes.push(node);
        }
      }
      parsed.nodes = dedupedNodes;

      // Check for orphan connection refs (non-fatal — ASTBuilder already drops
      // invalid connections, so the graph is still usable; surface as warnings).
      for (const connection of parsed.connections) {
        if (!seenIds.has(connection.source.nodeId)) {
          warnings.push(
            `Connection references unknown source node: ${connection.source.nodeId}`
          );
        }
        if (!seenIds.has(connection.target.nodeId)) {
          warnings.push(
            `Connection references unknown target node: ${connection.target.nodeId}`
          );
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (error) {
      return {
        valid: false,
        errors: [
          error instanceof Error ? error.message : 'Unknown parsing error',
        ],
        warnings: [],
      };
    }
  }

  /**
   * Get example syntax
   */
  static getExampleSyntax(): string {
    return `graph3d "Sample Application Architecture"

%% Node definitions
A[Function: processData]
B{Component: UserInterface}
C((Module: Database))
D<Datapath: eventStream>
E[[Class: UserModel]]
U~Person: Analyst~

%% Explicit containment ("in" membership)
S[Service: reporting] in <B>

%% Boundary + junction primitives
{Boundary: Reporting}
{Component: CrossCuttingConcerns}
junction J1

%% Connections (per-end arrow decorators)
A --> B : "processed data"
B -.-> D : "user events"
A <-- C : "raw data"        %% arrow at the SOURCE end
A <--> E : "shared model"   %% arrows at BOTH ends
F --- C : "headless link"

%% Directives
align row B U
align column A E
style Function, Service { color: "#4CAF50" }
relstyle dataflow { color: "#00BCD4", lineStyle: "dashed" }

%% Flow path definitions (auto-creates tagged connections)
flowpath "requestLifecycle" : B --> A --> C --> E
flowpath "eventPipeline" (-.->): D --> A --> B : "end-to-end event flow"`;
  }
}
