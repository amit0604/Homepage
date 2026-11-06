import React, { useId, useMemo, useState } from 'react';

/** A text box with a dropdown of existing categories that narrows as you type. New names are allowed. */
function CategoryCombobox({ value, onChange, options, inputId }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const matches = useMemo(() => {
    const all = Array.from(new Set(options.map((o) => String(o || '').trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
    const q = String(value || '').trim().toLowerCase();
    // A complete name means nothing has been searched for yet, so show every choice.
    if (!q || all.some((o) => o.toLowerCase() === q)) return all;
    return all.filter((o) => o.toLowerCase().includes(q));
  }, [options, value]);

  const choose = (option) => {
    onChange(option);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setOpen(true);
      setActive((i) => (matches.length ? (i + 1) % matches.length : -1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setOpen(true);
      setActive((i) => (matches.length ? (i <= 0 ? matches.length - 1 : i - 1) : -1));
    } else if (ev.key === 'Enter' && open && active >= 0 && matches[active]) {
      ev.preventDefault();
      choose(matches[active]);
    } else if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
    }
  };

  const showList = open && matches.length > 0;

  return (
    <div className="category-combobox">
      <input
        id={inputId}
        type="text"
        className="form-control"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Choose a category or type a new one"
        maxLength={80}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul id={listId} className="category-combobox__list" role="listbox">
          {matches.map((option, i) => (
            <li
              key={option}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`category-combobox__option${i === active ? ' category-combobox__option--active' : ''}`}
              dir="auto"
              onMouseDown={(ev) => {
                // Keeps focus in the box, so choosing does not close the list first.
                ev.preventDefault();
                choose(option);
              }}
            >
              {option}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default CategoryCombobox;
