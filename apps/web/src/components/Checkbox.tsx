import { useId, type ReactNode } from 'react';

/**
 * A checkbox that matches the rest of the surface.
 *
 * The native input is kept and visually hidden rather than replaced, so
 * keyboard, focus, form semantics and screen readers all keep working — a div
 * with a click handler would lose every one of those.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  size = 18,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: number;
  'aria-label'?: string;
}) {
  const id = useId();

  return (
    <label
      htmlFor={id}
      className="checkbox"
      data-disabled={disabled ? '' : undefined}
      style={{ ['--checkbox-size' as string]: `${size}px` }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox__box" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="100%" height="100%">
          <path
            d="M3.5 8.4l3 3 6-6.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {label !== undefined && <span className="checkbox__label">{label}</span>}
    </label>
  );
}
