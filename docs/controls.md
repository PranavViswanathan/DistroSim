# Controls reference

All input is handled in [`src/main.ts`](../src/main.ts). The canvas captures mouse and wheel events; keyboard listeners are attached to `window`.

## Keyboard

| Key                       | Action                                     |
|---------------------------|--------------------------------------------|
| `N`                       | Open the node-type picker at the cursor    |
| `S`                       | Toggle simulation (start / pause)          |
| `Space` (held) + drag     | Pan the canvas                             |
| `Backspace` / `Delete`    | Delete the current selection (node or edge)|
| `Cmd/Ctrl + Z`            | Undo last topology change                  |
| `Esc`                     | Cancel pending action (e.g., edge drag)    |

## Mouse

| Gesture                                  | Action                                      |
|------------------------------------------|---------------------------------------------|
| Click empty canvas                       | Clear selection                             |
| Click node                               | Select node, open config panel              |
| Click edge                               | Select edge, open edge panel                |
| Drag node                                | Move node                                   |
| Drag from output port → input port       | Create a new edge                           |
| Double-click node                        | Edit label inline                           |
| Scroll wheel                             | Zoom in/out at cursor                       |
| Space + drag (anywhere)                  | Pan                                         |

### Output and input ports

Each node has two small handles when selected or hovered:

- **Output port** — right side, used to start an edge drag
- **Input port** — left side, used to receive an edge drop

Hit-testing uses a `PORT_HIT_RADIUS` of 10px (see [`src/nodes.ts`](../src/nodes.ts)).

## Toolbar

| Control               | What it does                                                |
|-----------------------|-------------------------------------------------------------|
| ▶ / ⏸ button          | Start / pause the simulation (same as `S`)                  |
| Tick rate slider      | Change `state.ticksPerSec` (default 4)                      |
| Load preset dropdown  | Replace topology with a [preset](presets.md)                |
| Export                | Download topology as JSON                                   |
| Import                | Load a topology JSON                                        |
| Reset metrics         | Zero all running counters; topology untouched               |
| Clear canvas          | Delete every node and edge                                  |

## Sidebars

### Left — node palette

A grid of node types. Click a type to add one at the canvas center, or press `N` to drop it at the cursor.

### Right — config + chaos + log

When something is selected, you see a config panel. The chaos panel and event log are always visible:

- **Kill node** — needs a selected node
- **Partition** — needs an edge selected, *or* two nodes selected with an edge between them
- **Latency spike** — needs an edge selected
- **Cascade failure** — no selection needed; targets the most-loaded node

See [chaos.md](chaos.md) for the underlying primitives.

## Tips

- The simulation runs at `ticksPerSec`. Changing it does not change the per-tick math, only how often it runs and how packets animate.
- Selection is a single value — selecting a node clears the edge selection and vice versa.
- `Cmd/Ctrl + Z` undoes structural changes (add/remove nodes and edges, move nodes), not metric changes or chaos events.
