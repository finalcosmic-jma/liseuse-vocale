/* Liseuse vocale — mise en forme d'un chapitre Markdown en blocs à afficher / à lire.
   Règles tirées de claude/infos_depot_github.md (projet Final Cosmic Lore). */
(function (root) {
  'use strict';

  const ROMAN = /^\*{0,2}\s*[IVXLCDM]+\.\s*\*{0,2}$/;
  const SEP = /^[*_\s]*[─━—–\-_=·•*]{3,}[*_\s]*$/;
  const END = /^\*?\s*[—–-]\s*FIN\b[^a-zà-ÿ]*[—–-]\s*\*?$/;
  const COLOPHON = /^\*\*\s*FINAL COSMIC/i;
  const ROMAN_LINE = /^\*\s*Roman\s*\*$/i;
  const PART = /^\*{0,2}\s*(PREMIÈRE|DEUXIÈME|TROISIÈME|QUATRIÈME|CINQUIÈME|SIXIÈME|DERNIÈRE)\s+PARTIE\s*\*{0,2}$/i;

  function norm(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[*_#.,;:!?«»"'’()\s—–-]+/g, ' ').trim();
  }

  /* Retire *italique* et **gras** tout en gardant, pour chaque caractère, son style. */
  function inline(src) {
    let text = '', flags = [], it = false, bd = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length && '*_#'.includes(src[i + 1])) {
        text += src[i + 1]; flags.push((it ? 1 : 0) | (bd ? 2 : 0)); i++; continue;
      }
      if (c === '*' && src[i + 1] === '*') { bd = !bd; i++; continue; }
      if (c === '*') { it = !it; continue; }
      text += c; flags.push((it ? 1 : 0) | (bd ? 2 : 0));
    }
    // Espaces superflus laissés par la syntaxe
    const lead = text.length - text.trimStart().length;
    text = text.slice(lead); flags = flags.slice(lead);
    const end = text.trimEnd().length;
    return { text: text.slice(0, end), flags: flags.slice(0, end) };
  }

  function parse(md, opts) {
    opts = opts || {};
    const readEpi = opts.readEpigraph !== false;
    const lines = String(md).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let title = null, expectDup = false, epiZone = false, afterColophon = false, table = null;

    const push = (type, raw, speak, extra) => {
      const r = inline(raw);
      if (!r.text) return;
      blocks.push(Object.assign({ type, text: r.text, flags: r.flags, speak }, extra || {}));
    };

    for (let raw of lines) {
      const L = raw.trim();
      if (!L) { if (table) { blocks.push(table); table = null; } continue; }

      // Tableaux : affichés, jamais lus
      if (L.startsWith('|')) {
        if (!table) table = { type: 'table', rows: [], speak: false };
        if (!/^\|[\s:|-]+\|?$/.test(L)) table.rows.push(L.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()).text));
        continue;
      }
      if (table) { blocks.push(table); table = null; }

      const wasExpectDup = expectDup; expectDup = false;

      // Titres Markdown
      const h = L.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const txt = h[2].trim();
        if (!title && /^chapitre\b/i.test(inline(txt).text)) {
          const t = inline(txt).text;
          const m = t.match(/^(chapitre\s+\S+)\s*[—–:-]\s*(.+)$/i);
          title = { full: t, label: m ? m[1] : t, name: m ? m[2] : '' };
          push('title', txt, true, { suffix: /[.!?…]$/.test(t) ? '' : '.' });
          expectDup = true; epiZone = true;
        } else {
          push('heading', txt, true, { level: h[1].length, suffix: /[.!?…]$/.test(txt) ? '' : '.' });
          epiZone = false;
        }
        continue;
      }

      // Titre répété en gras juste après le titre
      if (wasExpectDup && title) {
        const b = L.match(/^\*\*(.+)\*\*$/);
        if (b && (norm(b[1]) === norm(title.name) || norm(b[1]) === norm(title.full))) continue;
      }

      if (END.test(L)) { push('end', L, false); epiZone = false; continue; }
      if (SEP.test(L) && !/[A-Za-zÀ-ÿ0-9]/.test(L)) { blocks.push({ type: 'sep', speak: false }); epiZone = false; continue; }
      if (ROMAN.test(L)) { push('section', L, false); epiZone = false; continue; }
      if (COLOPHON.test(L)) { push('colophon', L, false); afterColophon = true; epiZone = false; continue; }
      if (afterColophon && ROMAN_LINE.test(L)) { push('colophon', L, false); afterColophon = false; continue; }
      afterColophon = false;

      if (PART.test(L)) { push('part', L, true, { suffix: '.' }); epiZone = false; continue; }

      // Épigraphe : lignes en italique juste après le titre, jusqu'à l'attribution « — Nom »
      if (epiZone && /^\*(?!\*)/.test(L)) {
        const isAttr = /^\*\s*[—–-]/.test(L);
        push(isAttr ? 'epi-attr' : 'epi', L, readEpi);
        if (isAttr) epiZone = false;
        continue;
      }
      epiZone = false;

      push('p', L, true);
    }
    if (table) blocks.push(table);
    return { title, blocks };
  }

  /* Titre lisible pour la bibliothèque */
  function chapterTitle(md) {
    const m = String(md).match(/^\s*#\s+(.+)$/m);
    if (!m) return null;
    const t = inline(m[1]).text;
    const p = t.match(/^chapitre\s+\S+\s*[—–:-]\s*(.+)$/i);
    return p ? p[1] : t;
  }

  const api = { parse, inline, chapterTitle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Parse = api;
})(this);
