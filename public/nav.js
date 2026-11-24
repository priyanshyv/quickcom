// Shared top bar for every demo page. Include with <script src="/nav.js"></script>
// right after <body>.
(function () {
  const links = [
    ['/customer.html', 'Customer app'],
    ['/order.html', 'My orders', ['/order.html']],
    ['/pharmacist.html', 'Pharmacist'],
    ['sep'],
    ['/flash-sale.html', 'Lab: flash sale'],
    ['/payments-lab.html', 'Lab: payments'],
    ['sep'],
    ['/ops.html', 'Ops map'],
  ];
  const here = location.pathname === '/' ? '/customer.html' : location.pathname;
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML =
    '<a class="brand" href="/customer.html">⚡ Quick<span>Com</span></a><nav>' +
    links.map(([href, label]) => (href === 'sep' ? '<i class="sep"></i>' : `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`)).join('') +
    '</nav>';
  document.body.prepend(header);
})();
