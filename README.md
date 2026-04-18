# GlyphDraft: Font Design & Generation Tool

A professional-grade WYSIWYG environment for drafting, aligning, and exporting custom fonts (.OTF/.TTF).

## 🚀 Overview

GlyphDraft allows users to create fonts using a unique geometric "drafting" approach. Instead of traditional Bézier curves, users fill regions within a procedurally generated geometric grid. The app manages typographic balancing across a horizontal preview system and handles the complex mapping from canvas coordinates to font EM units.

---

## 🛠 Tech Stack

- **React 18 + Vite**: Fast, modern frontend framework.
- **Tailwind CSS**: Utility-first styling for a polished, minimalist UI.
- **opentype.js**: Core engine for generating and exporting font binary files.
- **motion (Framer Motion)**: Smooth UI transitions and view mode switching.
- **Lucide React**: Vector icons for the interface.

---

## 📁 Project Structure

- `src/App.tsx`: **Crucial File.** Contains 95% of the application logic including:
  - State management for all projects (projects are called "Folders").
  - The Geometric Engine (computes grid intersections and fillable regions).
  - The Font Export Engine (maps SVG paths to Opentype glyphs).
  - The System View & Live Preview UI.
- `src/main.tsx`: App entry point.
- `src/index.css`: Global styles and Tailwind imports.

---

## 🎯 Key Features

### 1. The Multi-View Interface
- **Editor Mode**: Focus on individual glyph construction. Use the grid parameters (Major/Minor axis, Rotation, etc.) to define your drafting environment.
- **System Mode**: A horizontal typographic preview of the entire typeface. Direct manipulation of glyphs allows for visual kerning and baseline balancing.

### 2. Typographic Balancing (System View)
- **Drag Vertically**: Adjust the `yOffset` (baseline shift) per glyph.
- **Drag Horizontally**: Adjust `LSB` (Left Side Bearing) and `RSB` (Right Side Bearing) for precise spacing.
- **Snapping**: Baseline shifts snap to typographic guides (X-Height, Cap Height).

### 3. Font Engine
- **Outline Expansion**: All filled regions are merged into a clean vector path on export.
- **Metric Mapping**: The app automatically maps the 800px canvas to a 1000-unit EM square, respecting your custom Ascender and Descender settings.

---

## 🤖 Context for AI Assistants (Cursor/Copilot/Gemini)

If you are using an AI to help maintain or extend this project, here is the technical context:

- **State Shape**: The `folders` state is a nested tree: `Folders -> Canvases -> filledRegions (Set of IDs)`.
- **Identity Logic**: Filled regions use `topologyId`. These IDs are generated based on the geometry's spatial relationship. This ensures that if you change the grid overlap, the "Bottom-Left" region of your 'A' stays filled if its relative topology remains similar.
- **Coordinate System**:
  - **Canvas**: 800x800, (0,0) is top-left.
  - **Font (OpenType)**: (0,0) is baseline-left. Y-axis points UP.
  - **Mapping**: Look for the `exportFont` function to see how the conversion between these systems is handled.
- **Persistence**: Data is automatically serialized to `localStorage` via a `useEffect` hook.

---

## 🔧 Development Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run Development Server**:
   ```bash
   npm run dev
   ```

3. **Build for Production**:
   ```bash
   npm run build
   ```

---

## 📜 Usage Tips
- **Sync Case Fills**: Toggle this in the sidebar to automatically mirror fills between uppercase and lowercase letters (e.g., 'a' and 'A').
- **Undo/Redo**: Full history support for every fill, rename, and project change.
- **Export**: Use "Export Project SVG" for a vector sheet of your entire typeface.