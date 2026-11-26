import { decodeDxf, parseDxf } from './parse';
import { dwgToDxf } from './dwg';

self.onmessage=async(event: MessageEvent<{bytes:ArrayBuffer;name:string}>)=>{
  try{
    const {name}=event.data;let bytes:Uint8Array=new Uint8Array(event.data.bytes);
    const dwg=/\.dwg$/i.test(name);let layerVisibility:Record<string,boolean>|undefined,unknown=0;
    if(dwg){
      const magic=new TextDecoder().decode(bytes.subarray(0,6));
      if(!['AC1012','AC1014','AC1015','AC1018','AC1021','AC1024','AC1027','AC1032'].includes(magic))throw new Error('DWG không hợp lệ hoặc phiên bản chưa hỗ trợ. Hãy lưu thành DWG R2000–R2018 hoặc ASCII DXF.');
      self.postMessage({progress:'Đang khởi động bộ đọc DWG cục bộ…'});
      const { LibreDwg }=await import('@mlightcad/libredwg-web');
      const lib=await LibreDwg.create(`${self.location.origin}/cad-assets`);
      self.postMessage({progress:'Đang chuyển DWG sang hình học 2D…'});
      const converted=dwgToDxf(lib,event.data.bytes);
      bytes=converted.bytes;layerVisibility=converted.layers;unknown=converted.unknown;
    }
    self.postMessage({progress:'Đang đọc hình học và layer…'});
    const drawing=parseDxf(decodeDxf(bytes),name,dwg?'DWG':'DXF',layerVisibility);
    if(unknown)drawing.warnings.unshift(`${unknown} đối tượng DWG không được bộ đọc nhận dạng đầy đủ.`);
    if(dwg)drawing.warnings.unshift('DWG được đọc bằng LibreDWG, có thể khác AutoCAD. Chỉ xuất Model Space 2D; hãy kiểm tra bản xem trước.');
    self.postMessage({drawing});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:'Không thể đọc bản vẽ CAD.'});}
};
