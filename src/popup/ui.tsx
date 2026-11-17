import React from 'react';
import { Switch } from '@base-ui-components/react/switch';
import { ToggleGroup } from '@base-ui-components/react/toggle-group';
import { Toggle as TogglePart } from '@base-ui-components/react/toggle';

/** 设置项一行：左标签 + 右控件，可选副标题 */
export function Row({
  label,
  hint,
  children,
  stacked,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? 'row row-stacked' : 'row'}>
      <div className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      <div className="row-ctl">{children}</div>
    </div>
  );
}

/** 开关：Base UI Switch（状态属性 data-checked，CSS 见 .sw） */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <Switch.Root
      className="sw"
      checked={checked}
      onCheckedChange={(v) => onChange(v)}
      aria-label={label}
    >
      <Switch.Thumb className="sw-thumb" />
    </Switch.Root>
  );
}

/** 分段单选：Base UI ToggleGroup + Toggle
 *  value 是数组（multiple=false 时仍以数组传递），onValueChange 取末位非空值 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      className="seg"
      value={[value]}
      aria-label={label}
      onValueChange={(groupValue) => {
        const next = groupValue[groupValue.length - 1];
        if (next) onChange(next as T);
      }}
    >
      {options.map((o) => (
        <TogglePart key={o.value} value={o.value} className="seg-item">
          {o.label}
        </TogglePart>
      ))}
    </ToggleGroup>
  );
}

export function Swatches({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label="高亮描边颜色">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.label}
          className={'swatch' + (value === o.value ? ' on' : '')}
          style={{ ['--c' as any]: o.value }}
          onClick={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}
