import fontkit from '@pdf-lib/fontkit';
import {
  EncryptedPDFError, PDFArray, PDFBool, PDFButton, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFField, PDFHexString, PDFName,
  PDFNumber, PDFObject, PDFOptionList, PDFRadioGroup, PDFRef, PDFSignature, PDFStream, PDFString, PDFTextField, PDFWidgetAnnotation,
  popGraphicsState, pushGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';

export type FormFieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';
export type FormValue = string | boolean | string[];

export interface FormFieldInfo {
  name: string;
  label: string;
  kind: FormFieldKind;
  readOnly: boolean;
  required: boolean;
  value: FormValue;
  options: string[];
  multiline: boolean;
  maxLength?: number;
  editable: boolean;
  multiSelect: boolean;
  /** Zero-based page of the field's first visible widget, or null when it is not placed on a page. */
  page: number | null;
}

export interface FormInfo {
  fields: FormFieldInfo[];
  signatureCount: number;
  buttonCount: number;
  hasXfa: boolean;
  /** The document was produced by this tool's flattening step. */
  flattenedByApp: boolean;
}

export const FLATTEN_MARKER = 'GiayPdfFormsFlattened';
const HIDDEN = 1 << 1, NO_VIEW = 1 << 5;

export class FormError extends Error {}

async function load(bytes: Uint8Array) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) throw new FormError('PDF này đang được đặt mật khẩu. Hãy gỡ mật khẩu trước khi điền biểu mẫu.');
    throw new FormError('Không đọc được biểu mẫu trong PDF này.');
  }
}

const acroFormOf = (pdf: PDFDocument) => pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
const textOf = (obj: unknown) => obj instanceof PDFString || obj instanceof PDFHexString ? obj.decodeText().trim() : '';

function pageLookup(pdf: PDFDocument) {
  const pages = pdf.getPages();
  const byAnnot = new Map<PDFDict, number>(), byRef = new Map<PDFRef, number>();
  pages.forEach((page, index) => {
    byRef.set(page.ref, index);
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = 0; annots && i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (annot instanceof PDFDict) byAnnot.set(annot, index);
    }
  });
  return (widget: PDFWidgetAnnotation) => {
    const ref = widget.P();
    return byAnnot.get(widget.dict) ?? (ref ? byRef.get(ref) : undefined);
  };
}

const visible = (widget: PDFWidgetAnnotation) => (widget.getFlags() & (HIDDEN | NO_VIEW)) === 0;
const rectOf = (widget: PDFWidgetAnnotation) => { try { return widget.getRectangle(); } catch { return { x: 0, y: 0, width: 0, height: 0 }; } };

function describe(field: PDFField): Omit<FormFieldInfo, 'name' | 'label' | 'readOnly' | 'required' | 'page'> | null {
  const base = { options: [] as string[], multiline: false, editable: false, multiSelect: false };
  if (field instanceof PDFTextField) {
    return { ...base, kind: 'text', value: field.getText() ?? '', multiline: field.isMultiline(), maxLength: field.getMaxLength() };
  }
  if (field instanceof PDFCheckBox) return { ...base, kind: 'checkbox', value: field.isChecked() };
  if (field instanceof PDFRadioGroup) return { ...base, kind: 'radio', value: field.getSelected() ?? '', options: field.getOptions() };
  const selectedLabels = (choice: PDFDropdown | PDFOptionList) => choice.getSelected().map(value => {
    const option = choice.acroField.getOptions().find(option => option.value.decodeText() === value);
    return option ? (option.display ?? option.value).decodeText() : value;
  });
  if (field instanceof PDFDropdown) {
    return { ...base, kind: 'dropdown', value: selectedLabels(field)[0] ?? '', options: field.getOptions(), editable: field.isEditable() };
  }
  if (field instanceof PDFOptionList) {
    const multiSelect = field.isMultiselect();
    const selected = selectedLabels(field);
    return { ...base, kind: 'list', value: multiSelect ? selected : selected[0] ?? '', options: field.getOptions(), multiSelect };
  }
  return null;
}

export async function readPdfForm(bytes: Uint8Array): Promise<FormInfo> {
  const pdf = await load(bytes);
  const acroForm = acroFormOf(pdf);
  const flattenedByApp = pdf.catalog.get(PDFName.of(FLATTEN_MARKER)) instanceof PDFBool;
  const info: FormInfo = { fields: [], signatureCount: 0, buttonCount: 0, hasXfa: !!acroForm?.has(PDFName.of('XFA')), flattenedByApp };
  if (!acroForm) return info;
  const pageOf = pageLookup(pdf);
  const order = new Map<string, [number, number, number]>();
  for (const field of pdf.getForm().getFields()) {
    if (field instanceof PDFSignature) { info.signatureCount++; continue; }
    if (field instanceof PDFButton) { info.buttonCount++; continue; }
    let details;
    try { details = describe(field); } catch { details = null; }
    if (!details) continue;
    const widgets = field.acroField.getWidgets();
    const placed = widgets.find(w => visible(w) && pageOf(w) !== undefined) ?? widgets.find(w => pageOf(w) !== undefined);
    const page = placed ? pageOf(placed)! : null;
    const rect = placed ? rectOf(placed) : { x: 0, y: 0, height: 0 };
    const name = field.getName();
    order.set(name, [page ?? Number.MAX_SAFE_INTEGER, -(rect.y + rect.height), rect.x]);
    info.fields.push({ ...details, name, label: textOf(field.acroField.dict.lookup(PDFName.of('TU'))) || field.acroField.getPartialName() || name, readOnly: field.isReadOnly(), required: field.isRequired(), page });
  }
  info.fields.sort((a, b) => {
    const [pa, ya, xa] = order.get(a.name)!, [pb, yb, xb] = order.get(b.name)!;
    return pa - pb || ya - yb || xa - xb;
  });
  return info;
}

function applyValue(field: PDFField, value: FormValue) {
  if (field instanceof PDFTextField) {
    const text = String(value);
    const max = field.getMaxLength();
    if (max !== undefined && [...text].length > max) throw new FormError(`Trường “${field.getName()}” chỉ nhận tối đa ${max} ký tự.`);
    if ((field.getText() ?? '') !== text) field.setText(text);
  } else if (field instanceof PDFCheckBox) {
    if (Boolean(value) !== field.isChecked()) value ? field.check() : field.uncheck();
  } else if (field instanceof PDFRadioGroup) {
    const option = String(value);
    if ((field.getSelected() ?? '') === option) return;
    if (!option) field.clear();
    else if (field.getOptions().includes(option)) field.select(option);
    else throw new FormError(`Lựa chọn không hợp lệ cho “${field.getName()}”.`);
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const chosen = (Array.isArray(value) ? value : [String(value)]).filter(Boolean);
    const current = field.getSelected();
    if (chosen.length === current.length && chosen.every((v, i) => v === current[i])) return;
    const options = field.getOptions();
    const editable = field instanceof PDFDropdown && field.isEditable();
    if (!editable && chosen.some(v => !options.includes(v))) throw new FormError(`Lựa chọn không hợp lệ cho “${field.getName()}”.`);
    const multi = field instanceof PDFDropdown ? field.isMultiselect() : field.isMultiselect();
    if (chosen.length > 1 && !multi) throw new FormError(`Trường “${field.getName()}” chỉ chọn được một giá trị.`);
    if (!chosen.length) field.clear(); else field.select(chosen);
  }
}

function appearanceOf(pdf: PDFDocument, widget: PDFWidgetAnnotation) {
  const ap = widget.dict.lookupMaybe(PDFName.of('AP'), PDFDict);
  let normal = ap?.get(PDFName.of('N'));
  let resolved = normal ? pdf.context.lookup(normal) : undefined;
  if (resolved instanceof PDFDict && !(resolved instanceof PDFStream)) {
    const state = widget.getAppearanceState();
    normal = state ? resolved.get(state) : undefined;
    resolved = normal ? pdf.context.lookup(normal) : undefined;
  }
  return resolved instanceof PDFStream ? normal : undefined;
}

const numbers = (arr: PDFArray | undefined, size: number) => {
  const values = arr ? arr.asArray().map(n => (n instanceof PDFNumber ? n.asNumber() : NaN)) : [];
  return values.length === size && values.every(Number.isFinite) ? values : undefined;
};

/** Maps an appearance stream's transformed BBox onto the widget Rect (PDF 32000-1 §12.5.5). */
function placement(pdf: PDFDocument, ref: PDFObject, widget: PDFWidgetAnnotation) {
  const stream = pdf.context.lookup(ref) as PDFStream;
  const box = numbers(stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray), 4);
  const rect = numbers(widget.dict.lookupMaybe(PDFName.of('Rect'), PDFArray), 4);
  if (!box || !rect) return undefined;
  const [a, b, c, d, e, f] = numbers(stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray), 6) ?? [1, 0, 0, 1, 0, 0];
  const corners = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [rx1, rx2, ry1, ry2] = [Math.min(rect[0], rect[2]), Math.max(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[1], rect[3])];
  if (maxX - minX <= 0 || maxY - minY <= 0 || rx2 - rx1 <= 0 || ry2 - ry1 <= 0) return undefined;
  const sx = (rx2 - rx1) / (maxX - minX), sy = (ry2 - ry1) / (maxY - minY);
  return [sx, 0, 0, sy, rx1 - minX * sx, ry1 - minY * sy] as const;
}

/** Copies indirect arrays the page shares with others so edits to one page never leak into another. */
function ownArray(pdf: PDFDocument, dict: PDFDict, key: string) {
  const name = PDFName.of(key), raw = dict.get(name);
  const arr = raw instanceof PDFRef ? pdf.context.lookup(raw) : undefined;
  if (arr instanceof PDFArray) dict.set(name, pdf.context.obj(arr.asArray()));
}

/** Gathers the field tree and XFA packets so the flattened file does not keep orphaned form objects. */
function collectFormObjects(pdf: PDFDocument, acroForm: PDFDict, refs: Set<PDFRef>) {
  const visit = (item: unknown) => {
    if (!(item instanceof PDFRef) || refs.has(item)) return;
    refs.add(item);
    const kids = pdf.context.lookupMaybe(item, PDFDict)?.lookupMaybe(PDFName.of('Kids'), PDFArray);
    kids?.asArray().forEach(visit);
  };
  acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray)?.asArray().forEach(visit);
  const xfa = acroForm.get(PDFName.of('XFA'));
  const xfaArr = xfa instanceof PDFRef ? pdf.context.lookup(xfa) : xfa;
  if (xfa instanceof PDFRef) refs.add(xfa);
  if (xfaArr instanceof PDFArray) xfaArr.asArray().forEach(item => { if (item instanceof PDFRef) refs.add(item); });
}

/**
 * Fills the form's editable fields with Unicode-capable appearances and flattens every widget into page content.
 * Page order, rotation and non-form annotations are left as they are.
 */
export async function fillPdfForm(bytes: Uint8Array, values: Record<string, FormValue>, fontBytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await load(bytes);
  const acroForm = acroFormOf(pdf);
  if (!acroForm) throw new FormError('PDF này không có trường biểu mẫu để điền.');
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const form = pdf.getForm();
  const fields = form.getFields();
  const changed = new Set<PDFField>();
  for (const field of fields) {
    const name = field.getName();
    if (!(name in values) || field.isReadOnly() || field instanceof PDFSignature || field instanceof PDFButton) continue;
    if (form.fieldIsDirty(field.ref)) form.markFieldAsClean(field.ref);
    applyValue(field, values[name]);
    if (!form.fieldIsDirty(field.ref)) continue;
    changed.add(field);
    // Toggling a box only switches /AS; keep the document's own on/off artwork when it exists.
    if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) form.markFieldAsClean(field.ref);
  }
  const regenerateAll = acroForm.lookup(PDFName.of('NeedAppearances')) === PDFBool.True;
  for (const field of fields) {
    if (field instanceof PDFSignature || field instanceof PDFButton) continue;
    if (regenerateAll && (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList)) form.markFieldAsDirty(field.ref);
    if (!field.needsAppearancesUpdate()) continue;
    try {
      field.defaultUpdateAppearances(font);
    } catch {
      if (changed.has(field)) throw new FormError(`Không tạo được hình hiển thị cho trường “${field.getName()}”.`);
    }
  }

  const pages = pdf.getPages();
  for (const page of pages) { ownArray(pdf, page.node, 'Contents'); ownArray(pdf, page.node, 'Annots'); }
  const pageOf = pageLookup(pdf);
  const widgetDicts = new Set<PDFDict>();
  const refsToDelete = new Set<PDFRef>();
  collectFormObjects(pdf, acroForm, refsToDelete);
  for (const field of fields) {
    for (const widget of field.acroField.getWidgets()) {
      widgetDicts.add(widget.dict);
      const index = pageOf(widget);
      const appearance = appearanceOf(pdf, widget);
      if (index === undefined || !appearance || !visible(widget)) continue;
      const matrix = placement(pdf, appearance, widget);
      if (!matrix || !(appearance instanceof PDFRef)) continue;
      const page = pages[index];
      const key = page.node.newXObject('FlatWidget', appearance);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix), drawObject(key), popGraphicsState());
    }
  }
  for (const page of pages) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    const kept = annots.asArray().filter(item => {
      const annot = pdf.context.lookup(item);
      if (!(annot instanceof PDFDict) || !widgetDicts.has(annot)) return true;
      if (item instanceof PDFRef) refsToDelete.add(item);
      return false;
    });
    if (kept.length) page.node.set(PDFName.of('Annots'), pdf.context.obj(kept));
    else page.node.delete(PDFName.of('Annots'));
  }
  for (const ref of refsToDelete) pdf.context.delete(ref);
  pdf.catalog.delete(PDFName.of('AcroForm'));
  pdf.catalog.set(PDFName.of(FLATTEN_MARKER), PDFBool.True);
  return pdf.save({ updateFieldAppearances: false });
}
