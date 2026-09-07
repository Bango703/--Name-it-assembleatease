(function () {
  'use strict';

  var catalog = (window.AAE_BOOKING_SOURCE && window.AAE_BOOKING_SOURCE.subcategories) || {};
  var selectedServices = new Set();
  var selectedItems = new Map();
  var activeService = '';
  var currentStep = 1;
  var selectedDate = null;
  var selectedTime = '';

  var serviceCards = Array.from(document.querySelectorAll('.service-card'));
  var formSteps = Array.from(document.querySelectorAll('.form-step'));
  var progressSteps = Array.from(document.querySelectorAll('[data-progress]'));
  var continueButton = document.getElementById('continue-button');
  var emptyState = document.getElementById('summary-empty');
  var selectionState = document.getElementById('summary-selection');
  var summaryServices = document.getElementById('summary-services');
  var summaryMoney = document.getElementById('summary-money');
  var summarySubtotal = document.getElementById('summary-subtotal');
  var summaryAddonsRow = document.getElementById('summary-addons-row');
  var summaryAddons = document.getElementById('summary-addons');
  var summaryEstimatedTotal = document.getElementById('summary-estimated-total');
  var summaryNext = document.querySelector('.summary-next strong');
  var serviceError = document.getElementById('service-error');
  var projectTabs = document.getElementById('project-tabs');
  var itemCatalog = document.getElementById('item-catalog');
  var itemSearch = document.getElementById('item-search');
  var groupFilter = document.getElementById('group-filter');
  var catalogStatus = document.getElementById('catalog-status');
  var customProject = document.getElementById('custom-project');
  var customDescription = document.getElementById('custom-description');

  var stepLabels = {
    1: 'Choose exact project items',
    2: 'Choose your preferred schedule',
    3: 'Add your contact details',
    4: 'Review the complete visit',
    5: 'Preview the confirmation'
  };

  function formatPrice(value) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0
    }).format(value);
  }

  function serviceLabel(serviceName) {
    var labels = {
      'Furniture Assembly': 'Furniture assembly',
      'Office Assembly': 'Office assembly',
      'Outdoor & Playsets': 'Outdoor assembly',
      'Fitness Equipment': 'Gym equipment',
      'Mounting & Hanging': 'TV mounting',
      'Other': 'Custom project'
    };
    return labels[serviceName] || serviceName;
  }

  function minimumBasePrice(serviceName) {
    var groups = catalog[serviceName] || [];
    var prices = [];
    groups.forEach(function (group) {
      (group.items || []).forEach(function (item) {
        if (!item.addon && !item.customQuote && Number(item.price) > 0) prices.push(Number(item.price));
      });
    });
    return prices.length ? Math.min.apply(Math, prices) : null;
  }

  function hydrateCatalogPrices() {
    serviceCards.forEach(function (card) {
      var priceTarget = card.querySelector('[data-price]');
      if (!priceTarget) return;
      var price = minimumBasePrice(card.dataset.service);
      priceTarget.textContent = price ? 'Options from ' + formatPrice(price) : 'View options';
    });
  }

  function itemKey(serviceName, itemName) {
    return serviceName + '::' + itemName;
  }

  function selectedItemsFor(serviceName) {
    return Array.from(selectedItems.values()).filter(function (entry) { return entry.service === serviceName; });
  }

  function getPreviewBreakdown() {
    return Array.from(selectedItems.values()).reduce(function (totals, entry) {
      var amount = Math.max(0, Number(entry.item.price) || 0);
      if (entry.item.addon) totals.addons += amount;
      else totals.services += amount;
      return totals;
    }, { services: 0, addons: 0 });
  }

  function hasCustomQuote() {
    return selectedServices.has('Other') || Array.from(selectedItems.values()).some(function (entry) {
      return entry.item.customQuote || Number(entry.item.price) === 0;
    });
  }

  function renderSummary() {
    var hasSelection = selectedServices.size > 0;
    var pricing = getPreviewBreakdown();
    var subtotal = pricing.services + pricing.addons;
    emptyState.hidden = hasSelection;
    selectionState.hidden = !hasSelection;
    continueButton.disabled = !hasSelection;
    serviceError.hidden = true;
    summaryServices.innerHTML = '';

    selectedServices.forEach(function (serviceName) {
      var count = selectedItemsFor(serviceName).length;
      var item = document.createElement('li');
      var label = document.createElement('span');
      var status = document.createElement('span');
      label.textContent = serviceLabel(serviceName);
      status.textContent = count ? count + (count === 1 ? ' item' : ' items') : 'Selected';
      item.append(label, status);
      summaryServices.appendChild(item);
    });

    summaryMoney.hidden = !subtotal && !hasCustomQuote();
    summarySubtotal.textContent = formatPrice(pricing.services);
    summaryAddonsRow.hidden = !pricing.addons;
    summaryAddons.textContent = formatPrice(pricing.addons);
    summaryEstimatedTotal.textContent = formatPrice(subtotal) + (hasCustomQuote() ? ' + quote, fees & tax' : ' + fees & tax');
    summaryNext.textContent = stepLabels[currentStep] || stepLabels[1];
  }

  function goToStep(stepNumber) {
    currentStep = stepNumber;
    formSteps.forEach(function (panel) {
      panel.hidden = Number(panel.dataset.step) !== stepNumber;
    });
    progressSteps.forEach(function (step) {
      var number = Number(step.dataset.progress);
      step.classList.toggle('is-active', number === stepNumber);
      step.classList.toggle('is-complete', number < stepNumber);
      if (number === stepNumber) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });

    if (stepNumber === 2) prepareProjectStep();
    if (stepNumber === 5) renderReview();
    renderSummary();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    var heading = document.querySelector('[data-step="' + stepNumber + '"] h1');
    if (heading) heading.setAttribute('tabindex', '-1');
  }

  function updateServiceSelection(card) {
    var serviceName = card.dataset.service;
    var isSelected = selectedServices.has(serviceName);
    if (isSelected) {
      selectedServices.delete(serviceName);
      Array.from(selectedItems.keys()).forEach(function (key) {
        if (selectedItems.get(key).service === serviceName) selectedItems.delete(key);
      });
    } else {
      selectedServices.add(serviceName);
    }
    card.setAttribute('aria-pressed', String(!isSelected));
    renderSummary();
  }

  function populateGroupFilter() {
    groupFilter.innerHTML = '';
    var allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All item groups';
    groupFilter.appendChild(allOption);
    (catalog[activeService] || []).forEach(function (group) {
      var option = document.createElement('option');
      option.value = group.group;
      option.textContent = group.group;
      groupFilter.appendChild(option);
    });
  }

  function renderProjectTabs() {
    projectTabs.innerHTML = '';
    selectedServices.forEach(function (serviceName) {
      let button = document.createElement('button');
      var count = document.createElement('span');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(serviceName === activeService));
      button.append(document.createTextNode(serviceLabel(serviceName)), count);
      count.textContent = serviceName === 'Other'
        ? (customDescription.value.trim() ? '1' : '0')
        : String(selectedItemsFor(serviceName).length);
      button.addEventListener('click', function () {
        activeService = serviceName;
        itemSearch.value = '';
        populateGroupFilter();
        renderProjectTabs();
        renderItemCatalog();
      });
      projectTabs.appendChild(button);
    });
  }

  function createCatalogItem(serviceName, groupName, item) {
    var key = itemKey(serviceName, item.name);
    var button = document.createElement('button');
    var name = document.createElement('strong');
    var price = document.createElement('span');
    var detail = document.createElement('small');
    button.type = 'button';
    button.className = 'catalog-item';
    button.setAttribute('aria-pressed', String(selectedItems.has(key)));
    name.textContent = item.name;
    price.className = 'item-price';
    price.textContent = item.customQuote || Number(item.price) === 0 ? 'Custom quote' : formatPrice(item.price);
    detail.textContent = item.addon ? 'Optional add-on' : (item.popular ? 'Popular choice' : groupName);
    button.append(name, price, detail);
    button.addEventListener('click', function () {
      if (selectedItems.has(key)) selectedItems.delete(key);
      else selectedItems.set(key, { service: serviceName, group: groupName, item: item });
      button.setAttribute('aria-pressed', String(selectedItems.has(key)));
      renderProjectTabs();
      renderSummary();
      document.getElementById('project-error').hidden = true;
    });
    return button;
  }

  function renderItemCatalog() {
    var isCustom = activeService === 'Other';
    document.querySelector('.catalog-toolbar').hidden = isCustom;
    catalogStatus.hidden = isCustom;
    itemCatalog.hidden = isCustom;
    customProject.hidden = !isCustom;
    if (isCustom) return;

    var query = itemSearch.value.trim().toLowerCase();
    var selectedGroup = groupFilter.value;
    var groups = catalog[activeService] || [];
    var visibleCount = 0;
    itemCatalog.innerHTML = '';

    groups.forEach(function (group) {
      if (selectedGroup && group.group !== selectedGroup) return;
      var matchingItems = (group.items || []).filter(function (item) {
        return !query || (item.name + ' ' + group.group).toLowerCase().indexOf(query) !== -1;
      });
      if (!matchingItems.length) return;

      var section = document.createElement('section');
      var title = document.createElement('h3');
      var list = document.createElement('div');
      section.className = 'catalog-group';
      list.className = 'catalog-items';
      title.textContent = group.group;
      matchingItems.forEach(function (item) {
        list.appendChild(createCatalogItem(activeService, group.group, item));
        visibleCount += 1;
      });
      section.append(title, list);
      itemCatalog.appendChild(section);
    });

    if (!visibleCount) {
      var empty = document.createElement('div');
      empty.className = 'catalog-empty';
      empty.textContent = 'No catalog items match that search. Try a broader term.';
      itemCatalog.appendChild(empty);
    }
    catalogStatus.textContent = visibleCount + (visibleCount === 1 ? ' option' : ' options') + ' for ' + serviceLabel(activeService);
  }

  function prepareProjectStep() {
    if (!selectedServices.has(activeService)) activeService = Array.from(selectedServices)[0] || '';
    itemSearch.value = '';
    populateGroupFilter();
    renderProjectTabs();
    renderItemCatalog();
  }

  function validateProjectStep() {
    var missingService = '';
    selectedServices.forEach(function (serviceName) {
      if (missingService) return;
      if (serviceName === 'Other') {
        if (customDescription.value.trim().length < 10) missingService = serviceName;
      } else if (!selectedItemsFor(serviceName).length) {
        missingService = serviceName;
      }
    });
    if (!missingService) return true;
    activeService = missingService;
    populateGroupFilter();
    renderProjectTabs();
    renderItemCatalog();
    var error = document.getElementById('project-error');
    error.textContent = missingService === 'Other'
      ? 'Add a short description of your custom project to continue.'
      : 'Choose at least one item for ' + serviceLabel(missingService) + '.';
    error.hidden = false;
    error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return false;
  }

  function generateDateOptions() {
    var holder = document.getElementById('date-options');
    holder.innerHTML = '';
    for (var index = 2; index < 8; index += 1) {
      var date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() + index);
      var iso = date.toISOString().slice(0, 10);
      let button = document.createElement('button');
      var day = document.createElement('span');
      var number = document.createElement('strong');
      var month = document.createElement('small');
      button.type = 'button';
      button.dataset.date = iso;
      button.dataset.display = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      button.setAttribute('aria-pressed', 'false');
      day.textContent = date.toLocaleDateString('en-US', { weekday: 'short' });
      number.textContent = date.getDate();
      month.textContent = date.toLocaleDateString('en-US', { month: 'short' });
      button.append(day, number, month);
      button.addEventListener('click', function () {
        holder.querySelectorAll('button').forEach(function (candidate) { candidate.setAttribute('aria-pressed', 'false'); });
        button.setAttribute('aria-pressed', 'true');
        selectedDate = { iso: button.dataset.date, display: button.dataset.display };
        document.getElementById('schedule-error').hidden = true;
      });
      holder.appendChild(button);
    }
  }

  function validateScheduleStep() {
    var address = document.getElementById('address-line').value.trim();
    var zip = document.getElementById('address-zip').value.trim();
    var city = document.getElementById('address-city').value.trim();
    var property = document.getElementById('property-type').value;
    var valid = selectedDate && selectedTime && address.length > 4 && /^\d{5}$/.test(zip) && city.length > 1 && property;
    var error = document.getElementById('schedule-error');
    error.hidden = !!valid;
    if (!valid) error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return !!valid;
  }

  function validateDetailsStep() {
    var first = document.getElementById('first-name').value.trim();
    var last = document.getElementById('last-name').value.trim();
    var email = document.getElementById('customer-email').value.trim();
    var phone = document.getElementById('customer-phone').value.replace(/\D/g, '');
    var valid = first.length > 1 && last.length > 1 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && phone.length >= 10;
    var error = document.getElementById('details-error');
    error.hidden = valid;
    if (!valid) error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return valid;
  }

  function createReviewBody(rows) {
    var body = document.createElement('div');
    body.className = 'review-card-body';
    rows.forEach(function (row) {
      var line = document.createElement('div');
      var label = document.createElement('span');
      var value = document.createElement('strong');
      line.className = 'review-row';
      label.textContent = row[0];
      value.textContent = row[1];
      line.append(label, value);
      body.appendChild(line);
    });
    return body;
  }

  function renderReview() {
    var pricing = getPreviewBreakdown();
    var subtotal = pricing.services + pricing.addons;
    document.getElementById('review-service-subtotal').textContent = formatPrice(pricing.services);
    document.getElementById('review-addons-row').hidden = !pricing.addons;
    document.getElementById('review-addons').textContent = formatPrice(pricing.addons);
    document.getElementById('review-estimated-total').textContent = formatPrice(subtotal) + (hasCustomQuote() ? ' + quote, required fees & tax' : ' + required fees & tax');
    var projectHolder = document.getElementById('review-project');
    projectHolder.innerHTML = '';
    var projectBody = document.createElement('div');
    projectBody.className = 'review-card-body';
    selectedServices.forEach(function (serviceName) {
      var group = document.createElement('div');
      var heading = document.createElement('strong');
      var list = document.createElement('ul');
      group.className = 'review-project-group';
      heading.textContent = serviceLabel(serviceName);
      if (serviceName === 'Other') {
        var customItem = document.createElement('li');
        customItem.textContent = customDescription.value.trim() + ' — custom quote';
        list.appendChild(customItem);
      } else {
        selectedItemsFor(serviceName).forEach(function (entry) {
          var item = document.createElement('li');
          item.textContent = entry.item.name + ' — ' + (entry.item.customQuote || !entry.item.price ? 'custom quote' : formatPrice(entry.item.price));
          list.appendChild(item);
        });
      }
      group.append(heading, list);
      projectBody.appendChild(group);
    });
    projectHolder.appendChild(projectBody);

    var unit = document.getElementById('address-unit').value.trim();
    var address = document.getElementById('address-line').value.trim() + (unit ? ', ' + unit : '') + ', ' + document.getElementById('address-city').value.trim() + ', TX ' + document.getElementById('address-zip').value.trim();
    var scheduleHolder = document.getElementById('review-schedule');
    scheduleHolder.innerHTML = '';
    scheduleHolder.appendChild(createReviewBody([
      ['Preferred date', selectedDate ? selectedDate.display : 'Not selected'],
      ['Arrival window', selectedTime || 'Not selected'],
      ['Service address', address],
      ['Project setting', document.getElementById('property-type').value]
    ]));

    var method = document.querySelector('input[name="contact-method"]:checked');
    var contactHolder = document.getElementById('review-contact');
    contactHolder.innerHTML = '';
    contactHolder.appendChild(createReviewBody([
      ['Customer', document.getElementById('first-name').value.trim() + ' ' + document.getElementById('last-name').value.trim()],
      ['Email', document.getElementById('customer-email').value.trim()],
      ['Mobile', document.getElementById('customer-phone').value.trim()],
      ['Updates', method ? method.value : 'Text message']
    ]));
  }

  serviceCards.forEach(function (card) {
    card.addEventListener('click', function () { updateServiceSelection(card); });
  });

  continueButton.addEventListener('click', function () {
    if (!selectedServices.size) {
      serviceError.hidden = false;
      return;
    }
    goToStep(2);
  });

  itemSearch.addEventListener('input', renderItemCatalog);
  groupFilter.addEventListener('change', renderItemCatalog);
  customDescription.addEventListener('input', function () {
    renderProjectTabs();
    renderSummary();
    document.getElementById('project-error').hidden = true;
  });

  document.getElementById('project-photos').addEventListener('change', function (event) {
    var list = document.getElementById('photo-list');
    list.innerHTML = '';
    Array.from(event.target.files || []).slice(0, 5).forEach(function (file) {
      var chip = document.createElement('span');
      chip.textContent = file.name;
      list.appendChild(chip);
    });
  });

  document.getElementById('project-continue').addEventListener('click', function () {
    if (validateProjectStep()) goToStep(3);
  });

  document.querySelectorAll('[data-time]').forEach(function (button) {
    button.addEventListener('click', function () {
      document.querySelectorAll('[data-time]').forEach(function (candidate) { candidate.setAttribute('aria-pressed', 'false'); });
      button.setAttribute('aria-pressed', 'true');
      selectedTime = button.dataset.time;
      document.getElementById('schedule-error').hidden = true;
    });
  });

  document.getElementById('schedule-continue').addEventListener('click', function () {
    if (validateScheduleStep()) goToStep(4);
  });

  document.getElementById('details-continue').addEventListener('click', function () {
    if (validateDetailsStep()) goToStep(5);
  });

  document.querySelectorAll('[data-back]').forEach(function (button) {
    button.addEventListener('click', function () { goToStep(Number(button.dataset.back)); });
  });

  document.querySelectorAll('[data-edit]').forEach(function (button) {
    button.addEventListener('click', function () { goToStep(Number(button.dataset.edit)); });
  });

  document.getElementById('review-confirm').addEventListener('click', function () {
    var checked = document.getElementById('terms-check').checked;
    document.getElementById('review-error').hidden = checked;
    if (!checked) return;
    document.getElementById('review-content').hidden = true;
    document.getElementById('confirmation-preview').hidden = false;
    document.getElementById('confirmation-date').textContent = (selectedDate ? selectedDate.display : '') + ' · ' + selectedTime;
    document.querySelector('.summary-card').hidden = true;
    document.querySelector('.booking-shell').classList.add('confirmation-layout');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.getElementById('start-over').addEventListener('click', function () {
    window.location.reload();
  });

  hydrateCatalogPrices();
  generateDateOptions();
  renderSummary();
})();
