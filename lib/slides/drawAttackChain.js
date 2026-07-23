const NODE_PALETTE = {
  initial:  { fill: "EAF1FB", border: "3583C9", text: "0F2440" },
  action:   { fill: "EEF2FF", border: "6366F1", text: "1E1B4B" },
  attack:   { fill: "FFF7ED", border: "FFAA22", text: "431407" },
  impact:   { fill: "FEF2F2", border: "CC0033", text: "450A0A" },
  defense:  { fill: "F0FDF4", border: "16A34A", text: "14532D" },
  _default: { fill: "F4F6F9", border: "64748B", text: "1A1A2E" },
};

const ARROW_COLOR = "94A3B8";

/**
 * Draw a left-to-right attack chain on a PptxGenJS slide using native shapes.
 * Handles up to ~8 steps; switches to two-row layout when steps > 5.
 *
 * @param {object} slide  — PptxGenJS slide object
 * @param {object} diag   — { steps: [{step, type}], caption }
 * @param {number} x, y, w, h — bounding box in inches
 */
export function drawAttackChain(slide, diag, x, y, w, h) {
  const steps = (diag.steps || []).filter(s => s && s.step);
  if (!steps.length) return;

  const CAPTION_H  = diag.caption ? 0.28 : 0;
  const CHAIN_AREA = h - CAPTION_H - 0.06;

  if (diag.caption) {
    slide.addText(diag.caption, {
      x, y, w, h: CAPTION_H,
      fontSize: 11, italic: true, bold: true, color: "1F3A5F",
      fontFace: "Calibri", valign: "middle",
    });
  }

  const chainY  = y + CAPTION_H;
  const useDouble = steps.length > 5;
  const row1    = useDouble ? steps.slice(0, Math.ceil(steps.length / 2)) : steps;
  const row2    = useDouble ? steps.slice(Math.ceil(steps.length / 2)) : [];

  function drawRow(rowSteps, rowY, rowH) {
    const n       = rowSteps.length;
    const ARROW_W = 0.28;
    const GAP     = 0.10;
    const totalArrow = (n - 1) * (ARROW_W + GAP * 2);
    const nodeW   = (w - totalArrow) / n;
    const nodeH   = Math.min(rowH * 0.80, 1.05);
    const nodeTopY = rowY + (rowH - nodeH) / 2;

    rowSteps.forEach((step, i) => {
      const nodeX  = x + i * (nodeW + ARROW_W + GAP * 2);
      const pal    = NODE_PALETTE[step.type] || NODE_PALETTE._default;

      slide.addShape("roundRect", {
        x: nodeX, y: nodeTopY, w: nodeW, h: nodeH,
        rectRadius: 0.07,
        fill: { color: pal.fill },
        line: { color: pal.border, pt: 1.5 },
      });

      // Step number badge (small circle top-left of node)
      const B = 0.20;
      slide.addShape("ellipse", {
        x: nodeX + 0.07, y: nodeTopY + 0.06,
        w: B, h: B,
        fill: { color: pal.border },
        line: { color: pal.border, pt: 0 },
      });
      slide.addText(String(i + 1), {
        x: nodeX + 0.07, y: nodeTopY + 0.06, w: B, h: B,
        fontSize: 7, bold: true, color: "FFFFFF",
        fontFace: "Arial", align: "center", valign: "middle",
      });

      // Step label — scale font down for many-node chains so text fits
      const labelFontSize = n <= 3 ? 13 : n <= 4 ? 11 : n <= 6 ? 9 : 8;
      slide.addText(step.step || "", {
        x: nodeX + 0.06, y: nodeTopY + 0.30,
        w: nodeW - 0.12, h: nodeH - 0.36,
        fontSize: labelFontSize, color: pal.text,
        fontFace: "Calibri", wrap: true,
        align: "center", valign: "top",
      });

      // Arrow to next
      if (i < rowSteps.length - 1) {
        const ax = nodeX + nodeW + GAP;
        const ay = nodeTopY + nodeH / 2;
        slide.addShape("line", {
          x: ax, y: ay, w: ARROW_W, h: 0,
          line: { color: ARROW_COLOR, pt: 1.5, endArrowType: "triangle" },
        });
      }
    });
  }

  if (useDouble) {
    const rowH   = CHAIN_AREA / 2 - 0.06;
    const gap    = 0.16;
    const row2Y  = chainY + rowH + gap;
    drawRow(row1, chainY, rowH);

    // L-shaped connector: right edge of row 1 → down → left → start of row 2
    // Leg 1: vertical drop from row 1 bottom-right to row 2 mid-height
    const legX   = x + w - 0.08;
    const leg1Y0 = chainY + rowH;
    const leg1Y1 = row2Y + rowH / 2;
    slide.addShape("line", {
      x: legX, y: leg1Y0, w: 0, h: leg1Y1 - leg1Y0,
      line: { color: ARROW_COLOR, pt: 1.5 },
    });
    // Leg 2: horizontal run RIGHT→LEFT back to start of row 2; arrowhead at the LEFT end
    slide.addShape("line", {
      x: x + 0.08, y: leg1Y1, w: legX - x - 0.08, h: 0,
      line: { color: ARROW_COLOR, pt: 1.5, beginArrowType: "triangle", endArrowType: "none" },
    });

    drawRow(row2, row2Y, rowH);
  } else {
    drawRow(row1, chainY, CHAIN_AREA);
  }

}
