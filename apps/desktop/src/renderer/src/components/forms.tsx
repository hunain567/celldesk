import { formatRupees, parseRupees } from '@nexodesk/shared';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

/** Today's local date as YYYY-MM-DD. */
export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Rupees shown without the "Rs" prefix, for inputs. */
function plainRupees(paisa: number): string {
  return formatRupees(paisa).replace(/^-?Rs /, '').replace(/,/g, '');
}

/**
 * Rupee amount input. The user types rupees ("1,250" or "1250.50"); the value
 * is integer paisa. An empty field is 0.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  id?: string;
  value: number;
  onChange: (paisa: number) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value ? plainRupees(value) : '');
  const [invalid, setInvalid] = useState(false);
  const last = useRef(value);

  useEffect(() => {
    // Follow changes made from outside (for example a price filled in automatically).
    if (value !== last.current) {
      last.current = value;
      setText(value ? plainRupees(value) : '');
      setInvalid(false);
    }
  }, [value]);

  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 10, top: 8, color: 'var(--color-text-subtle)', fontSize: 'var(--text-sm)' }}>Rs</span>
      <input
        id={id}
        className="cd-input num"
        style={{ paddingLeft: 32, width: '100%', textAlign: 'right' }}
        inputMode="decimal"
        autoFocus={autoFocus}
        placeholder={placeholder ?? '0'}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (next.trim() === '') {
            setInvalid(false);
            last.current = 0;
            onChange(0);
            return;
          }
          try {
            const paisa = parseRupees(next);
            if (paisa < 0) throw new RangeError('negative');
            setInvalid(false);
            last.current = paisa;
            onChange(paisa);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </div>
  );
}

export interface SearchOption {
  value: number;
  label: string;
  hint?: string;
}

/**
 * Searchable select for long lists (suppliers, handsets, items). Arrow keys and
 * Enter work, so it can be used without the mouse. `onCreate` adds a
 * "Create ..." entry for what was typed.
 */
export function SearchSelect({
  id,
  options,
  value,
  onChange,
  placeholder,
  onCreate,
  createLabel = 'Create',
  autoFocus,
}: {
  id?: string;
  options: SearchOption[];
  value: number | null;
  onChange: (value: number) => void;
  placeholder?: string;
  onCreate?: (text: string) => void;
  createLabel?: string;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? null;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((option) => terms.every((term) => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(term))).slice(0, 50);
  }, [options, text]);
  const canCreate = Boolean(onCreate && text.trim() && !options.some((option) => option.label.toLowerCase() === text.trim().toLowerCase()));
  const count = matches.length + (canCreate ? 1 : 0);

  function choose(index: number) {
    if (index < matches.length) {
      onChange(matches[index]!.value);
      setText('');
      setOpen(false);
    } else if (canCreate) {
      onCreate?.(text.trim());
      setText('');
      setOpen(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, count - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && open && count > 0) {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="cd-combobox">
      <input
        id={id}
        className="cd-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={selected ? selected.label : (placeholder ?? 'Type to search')}
        value={open ? text : selected?.label ?? text}
        onFocus={() => {
          setOpen(true);
          setText('');
          setActive(0);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {open && count > 0 ? (
        <ul id={listId} className="cd-combobox__list" role="listbox">
          {matches.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={index === active}
              className="cd-combobox__option"
              onMouseDown={(event) => {
                event.preventDefault();
                choose(index);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span>{option.label}</span>
              {option.hint ? <span className="cd-combobox__hint">{option.hint}</span> : null}
            </li>
          ))}
          {canCreate ? (
            <li
              role="option"
              aria-selected={active === matches.length}
              className="cd-combobox__option cd-combobox__create"
              onMouseDown={(event) => {
                event.preventDefault();
                choose(matches.length);
              }}
              onMouseEnter={() => setActive(matches.length)}
            >
              {createLabel} “{text.trim()}”
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
