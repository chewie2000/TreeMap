// src/App.jsx
import React, { useEffect, useMemo } from 'react';
import {
  useConfig,
  useEditorPanelConfig,
  useElementData,
  useElementColumns,
} from '@sigmacomputing/plugin';
import { hierarchy, treemap as d3Treemap } from 'd3-hierarchy';

// Logical layout space (D3 coordinate system)
const WIDTH = 600;
const HEIGHT = 380;

// Palette for categories (colors by top-level Category)
const PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
  '#bcbd22', '#17becf',
];

function App() {
  // Make the iframe document fill the plugin without scrollbars
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');

    if (html) {
      html.style.margin = '0';
      html.style.padding = '0';
      html.style.height = '100%';
    }
    if (body) {
      body.style.margin = '0';
      body.style.padding = '0';
      body.style.height = '100%';
      body.style.overflow = 'hidden';
    }
    if (root) {
      root.style.height = '100%';
    }
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
  ]);

  const config = useConfig(); // { source, category, detail, size }
  const sourceId   = config.source;
  const categoryId = config.category;
  const detailId   = config.detail;
  const sizeId     = config.size;

  const data = useElementData(sourceId);
  const cols = useElementColumns(sourceId);

  const categoryCol = categoryId && data ? data[categoryId] : undefined;
  const detailCol   = detailId   && data ? data[detailId]   : undefined;
  const sizeCol     = sizeId     && data ? data[sizeId]     : undefined;

  const categoryInfo = categoryId && cols ? cols[categoryId] : undefined;
  const detailInfo   = detailId   && cols ? cols[detailId]   : undefined;
  const sizeInfo     = sizeId     && cols ? cols[sizeId]     : undefined;

  // 2) Aggregate by Category + Detail and compute total for %
  const { rootData, total } = useMemo(() => {
    if (!categoryCol || !detailCol || !sizeCol) {
      return { rootData: null, total: 0 };
    }

    const catMap = new Map(); // cat -> (detail -> value)
    let totalVal = 0;

    for (let i = 0; i < categoryCol.length; i++) {
      const cat    = categoryCol[i] ?? '(null)';
      const detail = detailCol[i]   ?? '(null)';
      const val    = Number(sizeCol[i]) || 0;

      if (!Number.isFinite(val) || val <= 0) continue;

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
      const children = [];
      for (const [detail, value] of detailMap.entries()) {
        const pct = totalVal ? (value / totalVal) * 100 : 0;
        children.push({
          name: detail,
          category: cat,
          value,
          pct,
        });
      }

      categories.push({
        name: cat,
        children,
      });
    }

    const rootData = {
      name: 'root',
      children: categories,
    };

    return { rootData, total: totalVal };
  }, [categoryCol, detailCol, sizeCol]);

  // 3) D3 treemap layout → parent (category) frames + detail leaves
  const { categoryNodes, detailNodes } = useMemo(() => {
    if (!rootData || !total) return { categoryNodes: [], detailNodes: [] };

    const root = hierarchy(rootData)
      .sum(d => d.value)
      .sort((a, b) => (b.value || 0) - (a.value || 0));

    const layout = d3Treemap()
      .size([WIDTH, HEIGHT])
      .paddingInner(2);

    layout(root);

    const categories = root.children || [];
    const categoryNodes = categories.map((node, idx) => {
      const value = node.value || 0;
      const pct   = total ? (value / total) * 100 : 0;
      const color = PALETTE[idx % PALETTE.length];
      return {
        key: node.data.name,
        name: node.data.name,
        value,
        pct,
        x: node.x0,
        y: node.y0,
        width: node.x1 - node.x0,
        height: node.y1 - node.y0,
        color,
      };
    });

    const colorIndexByCategory = new Map(
      categoryNodes.map((c, idx) => [c.name, idx])
    );

    const leaves = root.leaves();
    const detailNodes = leaves.map((node) => {
      const detailName   = node.data.name;
      const categoryName = node.data.category;
      const value        = node.data.value;
      const pct          = node.data.pct;

      const idx = colorIndexByCategory.get(categoryName) ?? 0;
      const fill = PALETTE[idx % PALETTE.length];

      return {
        key: `${categoryName}::${detailName}`,
        category: categoryName,
        detail: detailName,
        value,
        pct,
        x: node.x0,
        y: node.y0,
        width: node.x1 - node.x0,
        height: node.y1 - node.y0,
        fill,
      };
    });

    return { categoryNodes, detailNodes };
  }, [rootData, total]);

  // 4) Guard states
  if (!sourceId || !categoryId || !detailId || !sizeId) {
    return (
      <div style={{ fontFamily: 'sans-serif', fontSize: 12, padding: 12 }}>
        In the editor panel, set:
        <ul>
          <li><b>source</b> (table/pivot)</li>
          <li><b>category</b> (top-level text column)</li>
          <li><b>detail</b> (detail / subcategory text column)</li>
          <li><b>size</b> (numeric column)</li>
        </ul>
      </div>
    );
  }

  if (!detailNodes.length || !total) {
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

  // Text fit estimation (with wrapping)
  const charUnits = 5;    // approx width per character in layout units
  const lineUnits = 14;   // approx height per line in layout units

  const canFitWrapped = (widthUnits, heightUnits, lines) => {
    if (widthUnits <= 0 || heightUnits <= 0) return false;
    const totalChars = lines.join(' ').length || 0;
    if (!totalChars) return true;

    const columns = Math.max(1, Math.floor(widthUnits / charUnits));
    const estLines = Math.ceil(totalChars / columns);
    const neededHeight = estLines * lineUnits;

    return neededHeight <= heightUnits;
  };

  // 5) Render: full-height container; SVG stretched; overlay labels with wrapping
  return (
    <div
      style={{
        margin: 0,
        padding: 0,
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'sans-serif',
      }}
    >
      {/* Background SVG with parent frames + detail rectangles */}
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
      >
        {/* Parent category frames: thick, colored by category */}
        {categoryNodes.map((c) => (
          <rect
            key={`parent-${c.key}`}
            x={c.x}
            y={c.y}
            width={Math.max(0, c.width)}
            height={Math.max(0, c.height)}
            fill="none"
            stroke={c.color}
            strokeWidth={10}   // thick frame
          />
        ))}

        {/* Detail rectangles inside frames */}
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
                % of total: {numberFmt.format(n.pct)}%
              </title>
            </rect>
          </g>
        ))}
      </svg>

      {/* HTML overlay for crisp labels (not stretched) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      >
        {/* Parent totals in top-left of each parent frame (wrapped, only if fit) */}
        {categoryNodes.map((c) => {
          const parentLines = [
            c.name,
            `${numberFmt.format(c.value)} ({numberFmt.format(c.pct)}%)`,
          ];

          if (!canFitWrapped(c.width, c.height, parentLines)) {
            return null;
          }

          const leftPct = (c.x / WIDTH) * 100;
          const topPct  = (c.y / HEIGHT) * 100;
          const maxWidthPct = (c.width / WIDTH) * 100;

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
              <div>
                {numberFmt.format(c.value)} ({numberFmt.format(c.pct)}%)
              </div>
            </div>
          );
        })}

        {/* Detail labels in the centre of larger detail rectangles (wrapped, only if fit) */}
        {detailNodes.map((n) => {
          const detailLines = [
            n.category,
            n.detail,
            `${numberFmt.format(n.value)} (${numberFmt.format(n.pct)}%)`,
          ];

          if (!canFitWrapped(n.width, n.height, detailLines)) {
            return null;
          }

          const centerX = (n.x + n.width / 2) / WIDTH * 100;
          const centerY = (n.y + n.height / 2) / HEIGHT * 100;
          const maxWidthPct = (n.width / WIDTH) * 100;

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
              <div>{n.category}</div>
              <div>{n.detail}</div>
              <div>
                {numberFmt.format(n.value)} ({numberFmt.format(n.pct)}%)
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default App;