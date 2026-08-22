import { useId, type ReactNode } from 'react';

/**
 * A radio that matches the rest of the surface.
 *
 * The same construction as Checkbox, for the same reason: the native input is
 * kept and visually hidden rather than replaced, so keyboard, focus, form
 * semantics, arrow-key movement within a group and screen readers all keep
 * working - a div with a click handler would lose every one of those.
 *
 * It exists because `accent-color` on a native radio recolours the dot and
 * nothing else, so a page could tick a drawn, clay checkbox above a browser's
 * own radio and look like two applications.
 */
export function Radio({
  checked,
  onChange,
  name,
  value,
  label,
  disabled,
  size = 18,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Radios only behave as a group when they share a name. */
  name: string;
  value: string;
  label?: ReactNode;
  disabled?: boolean;
  size?: number;
  'aria-label'?: string;
}) {
  const id = useId();

  return (
    <label htmlFor={id} className="radio" data-disabled={disabled ? '' : undefined}>
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        className="radio__dot"
        aria-hidden="true"
        style={{ ['--radio-size' as string]: `${size}px` }}
      />
      {label !== undefined && <span className="radio__label">{label}</span>}
    </label>
  );
}
