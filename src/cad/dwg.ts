import type { LibreDwgEx } from '@mlightcad/libredwg-web';

// LibreDWG 0.13's DXF writer can reverse the sign of layer colors. Read visibility
// from the native DWG database instead of inferring it from that DXF output.
export function dwgToDxf(lib:LibreDwgEx,bytes:ArrayBuffer) {
  const ptr=lib.dwg_read_data(bytes,0);
  if(!ptr)throw new Error('Không đọc được cơ sở dữ liệu DWG.');
  let layers:Record<string,boolean>={},unknown=0;
  try{
    const result=lib.convertEx(ptr);
    layers=Object.fromEntries(result.database.tables.LAYER.entries.map(l=>[l.name,!l.off&&!l.frozen&&l.plotFlag!==0]));
    unknown=result.stats.unknownEntityCount;
  }finally{lib.dwg_free(ptr);}
  const converted=lib.dwg_write_dxf(bytes);
  if(!converted?.length)throw new Error('LibreDWG không đọc được tệp này. Hãy lưu lại thành ASCII DXF hoặc DWG R2000.');
  return{bytes:converted,layers,unknown};
}
