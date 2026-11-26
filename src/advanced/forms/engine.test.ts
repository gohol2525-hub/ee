import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, StandardFonts, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { FLATTEN_MARKER, FormError, fillPdfForm, readPdfForm } from './engine.ts';

const font = new Uint8Array(await readFile('public/fonts/NotoSans-Regular.ttf'));

test('prefilled choice export codes map to labels before adding selections', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const list = pdf.getForm().createOptionList('choices');
  list.enableMultiselect();
  list.acroField.setOptions([{value:PDFHexString.fromText('a'),display:PDFHexString.fromText('Alpha')},{value:PDFHexString.fromText('b'),display:PDFHexString.fromText('Beta')}]);
  list.acroField.setValues([PDFHexString.fromText('a')]);
  list.addToPage(page,{x:20,y:200,width:200,height:100});
  const bytes = await pdf.save();
  const info = await readPdfForm(bytes);
  assert.deepEqual(info.fields[0].value, ['Alpha']);
  const output = await fillPdfForm(bytes, {choices:[...(info.fields[0].value as string[]),'Beta']}, font);
  assert.equal((await readPdfForm(output)).fields.length,0);
});

/** Form XObject that paints a marker word, used as hand-made checkbox/radio artwork. */
function markerStream(pdf: PDFDocument, fontRef: PDFRef, word: string) {
  const content = word ? `BT /F1 6 Tf 1 4 Td (${word}) Tj ET` : '';
  return pdf.context.register(pdf.context.flateStream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 60, 14], Resources: { Font: { F1: fontRef } },
  }));
}

async function buildFixture() {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const noto = await pdf.embedFont(font, { subset: true });
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const page1 = pdf.addPage([600, 800]);
  const page2 = pdf.addPage([500, 700]);
  page2.setRotation(degrees(90));
  page1.drawText('Phiếu đăng ký', { x: 50, y: 760, size: 16, font: noto });
  const form = pdf.getForm();

  const name = form.createTextField('khach.ten');
  name.setText('Trần Văn Cũ');
  name.addToPage(page1, { x: 50, y: 700, width: 300, height: 24, font: noto });
  const locked = form.createTextField('ma_ho_so');
  locked.setText('HS-001');
  locked.addToPage(page1, { x: 50, y: 660, width: 200, height: 24, font: noto });
  locked.enableReadOnly();
  const note = form.createTextField('ghi_chu');
  note.enableMultiline();
  note.addToPage(page1, { x: 50, y: 560, width: 300, height: 80, font: noto });
  const code = form.createTextField('ma_tinh');
  code.setMaxLength(3);
  code.addToPage(page1, { x: 400, y: 700, width: 80, height: 24, font: noto });

  const agree = form.createCheckBox('dong_y');
  agree.addToPage(page1, { x: 50, y: 520, width: 60, height: 14 });
  const gender = form.createRadioGroup('gioi_tinh');
  gender.addOptionToPage('Nam', page1, { x: 50, y: 490, width: 60, height: 14 });
  gender.addOptionToPage('Nữ', page1, { x: 120, y: 490, width: 60, height: 14 });
  const city = form.createDropdown('tinh');
  city.addOptions(['Hà Nội', 'Đà Nẵng', 'Huế']);
  city.addToPage(page1, { x: 50, y: 440, width: 200, height: 24, font: noto });
  const hobbies = form.createOptionList('so_thich');
  hobbies.addOptions(['Đọc sách', 'Bơi lội', 'Leo núi']);
  hobbies.enableMultiselect();
  hobbies.addToPage(page1, { x: 50, y: 340, width: 200, height: 80, font: noto });
  const rotated = form.createTextField('trang_hai');
  rotated.addToPage(page2, { x: 60, y: 300, width: 200, height: 24, font: noto });
  form.updateFieldAppearances(noto);

  // Replace pdf-lib's generated box artwork with hand-made on/off appearances so the flattened state is readable as text.
  const helvRef = helv.ref;
  const setStates = (widget: PDFDict, on: string, onWord: string, offWord: string) => {
    widget.set(PDFName.of('AP'), pdf.context.obj({ N: { [on]: markerStream(pdf, helvRef, onWord), Off: markerStream(pdf, helvRef, offWord) } }));
  };
  setStates(agree.acroField.getWidgets()[0].dict, 'Yes', 'CB_ON', 'CB_OFF');
  const [male, female] = gender.acroField.getWidgets();
  const [maleOn, femaleOn] = gender.acroField.getOnValues();
  setStates(male.dict, maleOn.decodeText(), 'RADIO_NAM', '');
  setStates(female.dict, femaleOn.decodeText(), 'RADIO_NU', '');

  // Signature field with its own visible look.
  const sigWidget = pdf.context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('chu_ky'), F: 4, Rect: [300, 100, 360, 114], P: page1.ref,
    AP: { N: markerStream(pdf, helvRef, 'SIG_LOOK') },
  });
  const sigRef = pdf.context.register(sigWidget);
  form.acroForm.addField(sigRef);
  page1.node.addAnnot(sigRef);
  // A sticky-note comment that is not part of the form and must survive flattening.
  page1.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 750, 520, 770], Contents: PDFHexString.fromText('Ghi chú') })));
  form.acroForm.dict.set(PDFName.of('XFA'), pdf.context.obj([PDFString.of('template'), pdf.context.register(pdf.context.flateStream('<template/>'))]));
  return pdf.save({ updateFieldAppearances: false });
}

async function pageTexts(bytes: Uint8Array) {
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const texts: { text: string; items: { str: string; transform: number[] }[]; rotate: number; annots: string[] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const items = (await page.getTextContent()).items.filter((x): x is typeof x & { str: string; transform: number[] } => 'str' in x);
    const annots = (await page.getAnnotations()).map(a => a.subtype as string);
    texts.push({ text: items.map(x => x.str).join(' '), items, rotate: page.rotate, annots });
  }
  await doc.destroy();
  return texts;
}

test('reads text, checkbox, radio, dropdown and list fields with values, options and read-only flags', async () => {
  const info = await readPdfForm(await buildFixture());
  assert.equal(info.hasXfa, true);
  assert.equal(info.signatureCount, 1);
  assert.equal(info.flattenedByApp, false);
  const byName = Object.fromEntries(info.fields.map(f => [f.name, f]));
  assert.deepEqual(info.fields.map(f => f.name), ['khach.ten', 'ma_tinh', 'ma_ho_so', 'ghi_chu', 'dong_y', 'gioi_tinh', 'tinh', 'so_thich', 'trang_hai']);
  assert.deepEqual({ kind: byName['khach.ten'].kind, value: byName['khach.ten'].value, label: byName['khach.ten'].label, page: byName['khach.ten'].page }, { kind: 'text', value: 'Trần Văn Cũ', label: 'ten', page: 0 });
  assert.equal(byName.ma_ho_so.readOnly, true);
  assert.equal(byName.ghi_chu.multiline, true);
  assert.equal(byName.ma_tinh.maxLength, 3);
  assert.deepEqual([byName.dong_y.kind, byName.dong_y.value], ['checkbox', false]);
  assert.deepEqual([byName.gioi_tinh.kind, byName.gioi_tinh.options, byName.gioi_tinh.value], ['radio', ['Nam', 'Nữ'], '']);
  assert.deepEqual([byName.tinh.kind, byName.tinh.options], ['dropdown', ['Hà Nội', 'Đà Nẵng', 'Huế']]);
  assert.deepEqual([byName.so_thich.kind, byName.so_thich.multiSelect, byName.so_thich.value], ['list', true, []]);
  assert.equal(byName.trang_hai.page, 1);
});

test('fills Vietnamese values, flattens every widget and keeps pages, rotation and comments', async () => {
  const source = await buildFixture();
  const out = await fillPdfForm(source, {
    'khach.ten': 'Nguyễn Thị Ánh', ma_ho_so: 'HACKED', ghi_chu: 'Đường Lê Lợi\nPhường Bến Thành', ma_tinh: 'HCM',
    dong_y: true, gioi_tinh: 'Nữ', tinh: 'Đà Nẵng', so_thich: ['Bơi lội', 'Leo núi'], trang_hai: 'Trang xoay ổn định',
  }, font);

  const [p1, p2] = await pageTexts(out);
  for (const expected of ['Phiếu đăng ký', 'Nguyễn Thị Ánh', 'HS-001', 'Đường Lê Lợi', 'Phường Bến Thành', 'HCM', 'CB_ON', 'RADIO_NU', 'Đà Nẵng', 'Bơi lội', 'SIG_LOOK']) {
    assert.ok(p1.text.includes(expected), `page 1 should show “${expected}”: ${p1.text}`);
  }
  for (const missing of ['HACKED', 'Trần Văn Cũ', 'CB_OFF', 'RADIO_NAM']) assert.ok(!p1.text.includes(missing), `page 1 should not show ${missing}`);
  assert.ok(p2.text.includes('Trang xoay ổn định'));
  assert.equal(p2.rotate, 90);
  assert.deepEqual(p1.annots, ['Text']);
  assert.deepEqual(p2.annots, []);

  const name = p1.items.find(x => x.str.includes('Nguyễn'))!;
  assert.ok(name.transform[4] > 50 && name.transform[4] < 60 && name.transform[5] > 700 && name.transform[5] < 724, `text placed inside its box: ${name.transform}`);

  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);
  assert.deepEqual(doc.getPages().map(p => [p.getWidth(), p.getHeight(), p.getRotation().angle]), [[600, 800, 0], [500, 700, 90]]);
  assert.equal(doc.catalog.get(PDFName.of('AcroForm')), undefined);
  assert.equal(doc.catalog.get(PDFName.of(FLATTEN_MARKER)), PDFBool.True);
});

test('the completed copy reopens with no fields and keeps its filled values', async () => {
  const once = await fillPdfForm(await buildFixture(), { 'khach.ten': 'Lê Minh Đức', dong_y: true }, font);
  const info = await readPdfForm(once);
  assert.deepEqual([info.fields.length, info.signatureCount, info.hasXfa, info.flattenedByApp], [0, 0, false, true]);
  const resaved = await (await PDFDocument.load(once)).save();
  const [page] = await pageTexts(resaved);
  assert.ok(page.text.includes('Lê Minh Đức') && page.text.includes('CB_ON'));
  await assert.rejects(fillPdfForm(once, {}, font), FormError);
});

test('unchanged fields keep their original values and appearances', async () => {
  const [page] = await pageTexts(await fillPdfForm(await buildFixture(), {}, font));
  assert.ok(page.text.includes('Trần Văn Cũ') && page.text.includes('CB_OFF') && page.text.includes('HS-001'));
  assert.ok(!page.text.includes('CB_ON'));
});

test('NeedAppearances forms are redrawn from their stored values', async () => {
  const pdf = await PDFDocument.load(await buildFixture());
  const field = pdf.getForm().getTextField('khach.ten');
  field.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText('Phạm Mới'));
  pdf.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  const [page] = await pageTexts(await fillPdfForm(await pdf.save({ updateFieldAppearances: false }), {}, font));
  assert.ok(page.text.includes('Phạm Mới') && !page.text.includes('Trần Văn Cũ'), page.text);
});

test('pages that share one content array are flattened independently', async () => {
  const pdf = await PDFDocument.load(await buildFixture());
  const [first, second] = pdf.getPages();
  const shared = pdf.context.register(pdf.context.obj((first.node.lookup(PDFName.of("Contents")) as PDFArray | undefined)?.asArray() ?? [first.node.get(PDFName.of('Contents'))]));
  first.node.set(PDFName.of('Contents'), shared);
  second.node.set(PDFName.of('Contents'), shared);
  const [p1, p2] = await pageTexts(await fillPdfForm(await pdf.save({ updateFieldAppearances: false }), { 'khach.ten': 'Chỉ trang một', trang_hai: 'Chỉ trang hai' }, font));
  assert.ok(p1.text.includes('Chỉ trang một') && !p1.text.includes('Chỉ trang hai'));
  assert.ok(p2.text.includes('Chỉ trang hai') && !p2.text.includes('Chỉ trang một'));
});

test('rejects values the form does not allow', async () => {
  const source = await buildFixture();
  await assert.rejects(fillPdfForm(source, { ma_tinh: 'QUÁ DÀI' }, font), /tối đa 3 ký tự/);
  await assert.rejects(fillPdfForm(source, { tinh: 'Sài Gòn' }, font), /không hợp lệ/);
  await assert.rejects(fillPdfForm(source, { gioi_tinh: 'Khác' }, font), /không hợp lệ/);
});

test('documents without AcroForm report an empty form', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const info = await readPdfForm(await pdf.save());
  assert.deepEqual([info.fields.length, info.hasXfa, info.flattenedByApp], [0, false, false]);
});
