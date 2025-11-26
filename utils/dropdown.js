/**
 * Simple utilities for styled dropdowns that mirror a hidden input element.
 * These helpers populate the visual list, keep the hidden value in sync and
 * allow programmatic value setting for dynamic option refreshes.
 */
(function() {
  function attachInputHandlers(input, list) {
    if (input.dataset.setup) return;
    let focusIndex = -1;
    const wrapper = input.closest('.dropdown-wrapper');

    if (wrapper && !wrapper.classList.contains('dropdown-display')) {
      wrapper.classList.add('dropdown-display');
    }

    if (wrapper && !wrapper.querySelector('.dropdown-arrow')) {
      const arrow = document.createElement('span');
      arrow.className = 'dropdown-arrow';
      const hiddenInput = [...wrapper.children].find(
        el => el.tagName === 'INPUT' && el.type === 'hidden'
      );
      wrapper.insertBefore(arrow, hiddenInput || null);
    }

    const toggleOpenState = open => {
      list.classList.toggle('open', open);
      input.classList.toggle('open', open);
      wrapper?.classList.toggle('open', open);
    };

    const visibleItems = () =>
      [...list.querySelectorAll('li')].filter(li => li.style.display !== 'none');

    input.addEventListener('click', () => {
      toggleOpenState(!list.classList.contains('open'));
    });

    input.addEventListener('focus', () => {
      focusIndex = -1;
    });

    input.addEventListener('blur', () => setTimeout(() => toggleOpenState(false), 200));

    input.addEventListener('input', () => {
      const val = input.value.toLowerCase();
      [...list.children].forEach(li => {
        li.style.display = li.textContent.toLowerCase().includes(val) ? '' : 'none';
      });
      focusIndex = -1;
      toggleOpenState(true);
    });

    input.addEventListener('keydown', e => {
      const items = visibleItems();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        toggleOpenState(true);
        focusIndex = Math.min(focusIndex + 1, items.length - 1);
        items[focusIndex]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        toggleOpenState(true);
        focusIndex = Math.max(focusIndex - 1, 0);
        items[focusIndex]?.focus();
      } else if (e.key === 'Enter') {
        if (focusIndex >= 0) {
          e.preventDefault();
          items[focusIndex]?.click();
        }
      }
    });

    input.dataset.setup = 'true';
  }

  window.setupStyledDropdown = function(hiddenId, options) {
    const wrapper = document.querySelector(`#${hiddenId}`).closest('.dropdown-wrapper');
    const input = wrapper.querySelector('.chosen-value');
    const list = wrapper.querySelector('.value-list');
    const hidden = document.getElementById(hiddenId);

    list.innerHTML = '';
    options.forEach(opt => {
      const li = document.createElement('li');
      li.textContent = opt.label || opt;
      li.dataset.value = opt.value || opt;
      li.tabIndex = 0;
      li.addEventListener('click', () => {
        input.value = li.textContent;
        hidden.value = li.dataset.value;
        list.classList.remove('open');
        input.classList.remove('open');
        wrapper?.classList.remove('open');
        hidden.dispatchEvent(new Event('change'));
      });
      list.appendChild(li);
    });

    attachInputHandlers(input, list);
  };

  window.setupStyledDropdownMulti = function(hiddenId, options) {
    const wrapper = document.querySelector(`#${hiddenId}`).closest('.dropdown-wrapper');
    const input = wrapper.querySelector('.chosen-value');
    const list = wrapper.querySelector('.value-list');
    const hidden = document.getElementById(hiddenId);

    list.innerHTML = '';
    options.forEach(opt => {
      const li = document.createElement('li');
      li.textContent = opt.label || opt;
      li.dataset.value = opt.value || opt;
      li.tabIndex = 0;
      li.addEventListener('click', () => {
        if (li.classList.contains('disabled')) return;
        li.classList.toggle('selected');
        const selected = [...list.querySelectorAll('.selected')];
        input.value = selected.map(s => s.textContent).join(', ');
        hidden.value = selected.map(s => s.dataset.value).join(',');
        hidden.dispatchEvent(new Event('change'));
      });
      list.appendChild(li);
    });

    attachInputHandlers(input, list);
  };

  window.setDropdownValue = function(hiddenId, value) {
    const hidden = document.getElementById(hiddenId);
    const wrapper = hidden?.closest('.dropdown-wrapper');
    const input = wrapper?.querySelector('.chosen-value');
    const list = wrapper?.querySelector('.value-list');
    const li = [...(list?.children || [])].find(l => l.dataset.value === value);
    if (li && input && hidden) {
      input.value = li.textContent;
      hidden.value = value;
    } else if (input && hidden) {
      input.value = '';
      hidden.value = value || '';
    }
  };

  window.setDropdownValues = function(hiddenId, values) {
    const arr = Array.isArray(values) ? values : String(values || '').split(',').filter(Boolean);
    const hidden = document.getElementById(hiddenId);
    const wrapper = hidden?.closest('.dropdown-wrapper');
    const input = wrapper?.querySelector('.chosen-value');
    const list = wrapper?.querySelector('.value-list');
    if (!hidden || !input || !list) return;
    [...list.children].forEach(li => {
      if (arr.includes(li.dataset.value)) li.classList.add('selected');
      else li.classList.remove('selected');
    });
    input.value = [...list.querySelectorAll('.selected')].map(li => li.textContent).join(', ');
    hidden.value = arr.join(',');
  };
})();
