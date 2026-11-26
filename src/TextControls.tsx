import { Bold, Italic } from 'lucide-react';
import type { TextSettings } from './model';

export function TextControls({ value, onChange, label = 'Nội dung' }: { value: TextSettings; onChange: (patch: Partial<TextSettings>) => void; label?: string }) {
  const sizes = [...new Set([6,8,10,12,14,16,18,20,24,28,32,36,48,64,72,96,Math.round(value.size * 10) / 10])].sort((a,b)=>a-b);
  return <div className="text-controls">
    <label className="field-label">{label}<textarea value={value.text} rows={3} maxLength={4000} onChange={e=>onChange({text:e.target.value})}/></label>
    <label className="field-label">Phông chữ<select value={value.fontFamily || 'sans'} onChange={e=>onChange({fontFamily:e.target.value as 'sans'|'serif'})}><option value="sans">Noto Sans · Không chân</option><option value="serif">Noto Serif · Có chân</option></select></label>
    <div className="text-style-row"><label className="field-label">Cỡ chữ<select value={Math.round(value.size*10)/10} onChange={e=>onChange({size:Number(e.target.value)})}>{sizes.map(size=><option key={size} value={size}>{size} pt</option>)}</select></label>
      <div className="text-style-buttons" role="group" aria-label="Kiểu chữ"><button type="button" className={value.bold?'chosen':''} aria-label="Đậm" aria-pressed={!!value.bold} onClick={()=>onChange({bold:!value.bold})}><Bold size={18}/></button><button type="button" className={value.italic?'chosen':''} aria-label="Nghiêng" aria-pressed={!!value.italic} onClick={()=>onChange({italic:!value.italic})}><Italic size={18}/></button></div>
      <label className="field-label">Màu chữ<input type="color" value={value.color} onChange={e=>onChange({color:e.target.value})}/></label>
    </div>
  </div>;
}
