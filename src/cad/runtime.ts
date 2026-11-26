import type { CadDrawing } from './types';

export async function readCad(file: File,signal: AbortSignal,onProgress:(message:string)=>void): Promise<CadDrawing> {
  if(file.size>50*1024*1024)throw new Error('Tệp CAD tối đa 50 MB. Hãy chọn tệp nhỏ hơn.');
  signal.throwIfAborted();
  const bytes=await file.arrayBuffer();signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./cad.worker.ts',import.meta.url),{type:'module'});
    let settled=false;
    const finish=(drawing?:CadDrawing,error?:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timeout);worker.terminate();signal.removeEventListener('abort',abort);
      if(drawing)resolve(drawing);else reject(error);
    };
    const abort=()=>finish(undefined,new DOMException('Đã hủy','AbortError'));
    const timeout=setTimeout(()=>finish(undefined,new Error('Bộ đọc CAD quá thời gian (60 giây). Hãy tách bản vẽ nhỏ hơn hoặc lưu thành DXF.')),60000);
    signal.addEventListener('abort',abort,{once:true});
    worker.onmessage=(event:MessageEvent<{drawing?:CadDrawing;error?:string;progress?:string}>)=>{
      if(event.data.progress&&!settled)onProgress(event.data.progress);
      if(event.data.drawing)finish(event.data.drawing);
      else if(event.data.error)finish(undefined,new Error(event.data.error));
    };
    worker.onerror=()=>finish(undefined,new Error('Không tải được bộ đọc CAD. Hãy tải lại trang hoặc chọn tệp nhỏ hơn.'));
    worker.postMessage({name:file.name,bytes},[bytes]);
    if(signal.aborted)abort();
  });
}
