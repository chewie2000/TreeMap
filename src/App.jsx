// src/App.jsx
import React, { useEffect, useMemo } from 'react';
import {
  useConfig,
  useEditorPanelConfig,
  useElementData,
  useElementColumns,
} from '@sigmacomputing/plugin';
import { hierarchy, treemap as d3Treemap } from 'd3-hierarchy';

// 3×3 grid layout constants (all in logical SVG units)
const GRID = 3;
const GAP  = 6;
const CELL = 196;
const SIZE = GRID * CELL + (GRID - 1) * GAP; // 600

// Palette – fallback colours per category slot
const PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
  '#bcbd22', '#17becf',
];

// Label size minimums (in logical units)
const MIN_PARENT_LABEL_WIDTH  = 80;
const MIN_PARENT_LABEL_HEIGHT = 40;
const MIN_DETAIL_LABEL_WIDTH  = 70;
const MIN_DETAIL_LABEL_HEIGHT = 30;

// Normalize a hex/rgb color value from data into a CSS color string.
// Accepts "FF0000", "#FF0000", "rgb(...)", "hsl(...)", or named colors.
const normalizeColor = (value) => {
  if (value == null) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  if (/^#?[0-9a-fA-F]{6}$/.test(s)) return s.startsWith('#') ? s : `#${s}`;
  if (/^rgb\s*\(/i.test(s) || /^hsl\s*\(/i.test(s)) return s;
  return s;
};

// Map category index (0–8) to grid top-left corner.
// Order: bottom-left → right along bottom row → next row up → top-right.
function cellXY(i) {
  const col        = i % GRID;
  const rowFromTop = (GRID - 1) - Math.floor(i / GRID);
  return {
    x: col * (CELL + GAP),
    y: rowFromTop * (CELL + GAP),
  };
}

function App() {
  // Fill the plugin iframe without scrollbars
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    if (html) { html.style.margin = '0'; html.style.padding = '0'; html.style.height = '100%'; }
    if (body) { body.style.margin = '0'; body.style.padding = '0'; body.style.height = '100%'; body.style.overflow = 'hidden'; }
    if (root) { root.style.height = '100%'; }
  }, []);

  // 1) Sigma editor panel config
  useEditorPanelConfig([
    { type: 'element', name: 'source' },
    {
      type: 'column',
      name: 'category',
      source: 'source',
      allowMultiple: false,
      allowedTypes: ['text'],
    },
    {
      type: 'column',
      name: 'detail',
      source: 'source',
      allowMultiple: false,
      allowedTypes: ['text'],
    },
    {
      type: 'column',
      name: 'size',
      source: 'source',
      allowMultiple: false,
      allowedTypes: ['number', 'integer'],
    },
    {
      type: 'column',
      name: 'parentColor',
      source: 'source',
      allowMultiple: false,
      allowedTypes: ['text'],
    },
  ]);

  const config        = useConfig();
  const sourceId      = config.source;
  const categoryId    = config.category;
  const detailId      = config.detail;
  const sizeId        = config.size;
  const parentColorId = config.parentColor;

  const data = useElementData(sourceId);
  const cols = useElementColumns(sourceId);

  const categoryCol    = categoryId    && data ? data[categoryId]    : undefined;
  const detailCol      = detailId      && data ? data[detailId]      : undefined;
  const sizeCol        = sizeId        && data ? data[sizeId]        : undefined;
  const parentColorCol = parentColorId && data ? data[parentColorId] : undefined;

  const categoryInfo = categoryId && cols ? cols[categoryId] : undefined;
  const detailInfo   = detailId   && cols ? cols[detailId]   : undefined;
  const sizeInfo     = sizeId     && cols ? cols[sizeId]     : undefined;

  // 2) Aggregate by category then detail.
  //    Capture per-category color (first non-empty value wins).
  //    Cap at 9 categories. Sort alphabetically — grid runs A-Z bottom-left to top-right.
  const { rootData, total } = useMemo(() => {
    if (!categoryCol || !detailCol || !sizeCol) {
      return { rootData: null, total: 0 };
    }

    const catMap      = new Map(); // category → Map(detail → value)
    const catColorMap = new Map(); // category → normalized CSS color
    let totalVal = 0;

    for (let i = 0; i < categoryCol.length; i++) {
      const cat    = categoryCol[i] ?? '(null)';
      const detail = detailCol[i]   ?? '(null)';
      const val    = Number(sizeCol[i]) || 0;

      if (!Number.isFinite(val) || val <= 0) continue;
      if (!catMap.has(cat) && catMap.size >= 9) continue;

      // First non-empty color for this category wins
      if (parentColorCol) {
        const norm = normalizeColor(parentColorCol[i]);
        if (norm && !catColorMap.has(cat)) catColorMap.set(cat, norm);
      }

      let detailMap = catMap.get(cat);
      if (!detailMap) {
        detailMap = new Map();
        catMap.set(cat, detailMap);
      }
      detailMap.set(detail, (detailMap.get(detail) || 0) + val);
      totalVal += val;
    }

    const categories = [];
    for (const [cat, detailMap] of catMap.entries()) {
      const catTotal = Array.from(detailMap.values()).reduce((s, v) => s + v, 0);
      const children = [];
      for (const [detail, value] of detailMap.entries()) {
        children.push({
          name: detail,
          category: cat,
          value,
          pct: catTotal ? (value / catTotal) * 100 : 0, // within-category %
        });
      }
      categories.push({
        name: cat,
        color: catColorMap.get(cat), // undefined if no parentColor column
        children,
        catTotal,
      });
    }

    // Alphabetical sort → grid positions run A-Z from bottom-left to top-right
    categories.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );

    return {
      rootData: { name: 'root', children: categories },
      total: totalVal,
    };
  }, [categoryCol, detailCol, sizeCol, parentColorCol]);

  // 3) Fixed 3×3 grid for parent cells; D3 treemap per cell for detail items.
  const { categoryNodes, detailNodes } = useMemo(() => {
    if (!rootData) return { categoryNodes: [], detailNodes: [] };

    const catNodes = [];
    const detNodes = [];

    rootData.children.forEach((cat, idx) => {
      const { x: x0, y: y0 } = cellXY(idx);
      const fallback = PALETTE[idx % PALETTE.length];
      const color    = normalizeColor(cat.color) || fallback;

      catNodes.push({
        key:    cat.name,
        name:   cat.name,
        value:  cat.catTotal,
        pct:    total ? (cat.catTotal / total) * 100 : 0,
        x:      x0,
        y:      y0,
        width:  CELL,
        height: CELL,
        color,
      });

      // D3 treemap inside this cell — size column drives detail layout
      const cellRoot = hierarchy({ name: cat.name, children: cat.children })
        .sum(d => d.value)
        .sort((a, b) => (b.value || 0) - (a.value || 0));

      d3Treemap().size([CELL, CELL]).paddingInner(1)(cellRoot);

      (cellRoot.leaves() || []).forEach(leaf => {
        detNodes.push({
          key:      `${cat.name}::${leaf.data.name}`,
          category: cat.name,
          detail:   leaf.data.name,
          value:    leaf.data.value,
          pct:      leaf.data.pct,
          x:        x0 + leaf.x0,
          y:        y0 + leaf.y0,
          width:    leaf.x1 - leaf.x0,
          height:   leaf.y1 - leaf.y0,
          fill:     color,
        });
      });
    });

    return { categoryNodes: catNodes, detailNodes: detNodes };
  }, [rootData, total]);

  // 4) Guard states
  if (!sourceId || !categoryId || !detailId || !sizeId) {
    return (
      <div style={{ fontFamily: 'sans-serif', fontSize: 12, padding: 12 }}>
        In the editor panel, set:
        <ul>
          <li><b>source</b> (table/pivot)</li>
          <li><b>category</b> (top-level text column — up to 9 used)</li>
          <li><b>detail</b> (detail / subcategory text column)</li>
          <li><b>size</b> (numeric column — drives detail rectangle sizes)</li>
          <li>(optional) <b>parentColor</b> (text color per row, e.g. FF0000 or #FF0000)</li>
        </ul>
      </div>
    );
  }

  if (!categoryNodes.length) {
    return (
      <div style={{ fontFamily: 'sans-serif', fontSize: 12, padding: 12 }}>
        No data available for the selected columns.
      </div>
    );
  }

  const categoryLabel = categoryInfo?.name ?? 'Category';
  const detailLabel   = detailInfo?.name   ?? 'Detail';
  const sizeLabel     = sizeInfo?.name     ?? 'Size';

  const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  const charUnits = 5;
  const lineUnits = 14;

  const canFitWrapped = (widthUnits, heightUnits, lines) => {
    if (widthUnits <= 0 || heightUnits <= 0) return false;
    const totalChars = lines.join(' ').length || 0;
    if (!totalChars) return true;
    const columns  = Math.max(1, Math.floor(widthUnits / charUnits));
    const estLines = Math.ceil(totalChars / columns);
    return estLines * lineUnits <= heightUnits;
  };

  // 5) Render: square SVG + HTML overlay for crisp labels
  return (
    <div
      style={{
        margin: 0, padding: 0,
        width: '100%', height: '100%',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'sans-serif',
      }}
    >
      {/* Background SVG: category frames + detail rectangles */}
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        preserveAspectRatio="none"
      >
        {/* Category cell frames */}
        {categoryNodes.map((c) => (
          <rect
            key={`parent-${c.key}`}
            x={c.x}
            y={c.y}
            width={c.width}
            height={c.height}
            fill="none"
            stroke={c.color}
            strokeWidth={10}
          />
        ))}

        {/* Detail rectangles inside each cell */}
        {detailNodes.map((n) => (
          <g key={n.key}>
            <rect
              x={n.x}
              y={n.y}
              width={Math.max(0, n.width)}
              height={Math.max(0, n.height)}
              fill={n.fill}
              stroke="#fff"
            >
              <title>
                {categoryLabel}: {n.category}
                {'\n'}
                {detailLabel}: {n.detail}
                {'\n'}
                {sizeLabel}: {numberFmt.format(n.value)}
                {'\n'}
                % of category: {numberFmt.format(n.pct)}%
              </title>
            </rect>
          </g>
        ))}
      </svg>

      {/* HTML overlay for crisp (non-stretched) labels */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>

        {/* Category name + total in top-left of each cell */}
        {categoryNodes.map((c) => {
          if (c.width < MIN_PARENT_LABEL_WIDTH || c.height < MIN_PARENT_LABEL_HEIGHT) return null;
          const parentLines = [
            c.name,
            `${numberFmt.format(c.value)} (${numberFmt.format(c.pct)}%)`,
          ];
          if (!canFitWrapped(c.width, c.height, parentLines)) return null;

          const leftPct     = (c.x / SIZE) * 100;
          const topPct      = (c.y / SIZE) * 100;
          const maxWidthPct = (c.width / SIZE) * 100;

          return (
            <div
              key={`parent-label-${c.key}`}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: `${topPct}%`,
                transform: 'translate(4px, 4px)',
                fontSize: 11,
                color: '#000',
                background: 'transparent',
                padding: '2px 4px',
                borderRadius: 3,
                border: `1px solid ${c.color}`,
                maxWidth: `${maxWidthPct}%`,
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                textAlign: 'left',
              }}
            >
              <div><b>{c.name}</b></div>
              <div>{numberFmt.format(c.value)} ({numberFmt.format(c.pct)}%)</div>
            </div>
          );
        })}

        {/* Detail labels centred on larger detail rectangles */}
        {detailNodes.map((n) => {
          if (n.width < MIN_DETAIL_LABEL_WIDTH || n.height < MIN_DETAIL_LABEL_HEIGHT) return null;
          const detailLines = [
            n.detail,
            `${numberFmt.format(n.value)} (${numberFmt.format(n.pct)}%)`,
          ];
          if (!canFitWrapped(n.width, n.height, detailLines)) return null;

          const centerX     = ((n.x + n.width  / 2) / SIZE) * 100;
          const centerY     = ((n.y + n.height / 2) / SIZE) * 100;
          const maxWidthPct = (n.width / SIZE) * 100;

          return (
            <div
              key={`detail-label-${n.key}`}
              style={{
                position: 'absolute',
                left: `${centerX}%`,
                top: `${centerY}%`,
                transform: 'translate(-50%, -50%)',
                fontSize: 11,
                color: '#000',
                background: 'transparent',
                padding: '2px 4px',
                borderRadius: 3,
                maxWidth: `${maxWidthPct}%`,
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                textAlign: 'center',
              }}
            >
              <div><b>{n.detail}</b></div>
              <div>{numberFmt.format(n.value)} ({numberFmt.format(n.pct)}%)</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default App;
