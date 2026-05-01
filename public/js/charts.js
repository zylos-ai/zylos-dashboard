let chart = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function dataOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function updateOverviewChart(data) {
  const canvas = document.querySelector('#overview-chart');
  if (!canvas || !window.Chart) return;

  const labels = ['Context', 'Cache', 'Services', 'Tool failures'];
  const values = [
    dataOrZero(data.context),
    dataOrZero(data.cache),
    data.servicesTotal ? Math.round((data.servicesOnline / data.servicesTotal) * 100) : 0,
    dataOrZero(data.toolFailures)
  ];

  const colors = [
    cssVar('--chart-palette-1'),
    cssVar('--chart-palette-2'),
    cssVar('--chart-palette-3'),
    cssVar('--chart-palette-4')
  ];

  if (!chart) {
    chart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { color: cssVar('--text-secondary') },
            grid: { color: cssVar('--border-subtle') }
          },
          x: {
            ticks: { color: cssVar('--text-secondary') },
            grid: { display: false }
          }
        }
      }
    });
    return;
  }

  chart.data.datasets[0].data = values;
  chart.data.datasets[0].backgroundColor = colors;
  chart.options.scales.y.ticks.color = cssVar('--text-secondary');
  chart.options.scales.y.grid.color = cssVar('--border-subtle');
  chart.options.scales.x.ticks.color = cssVar('--text-secondary');
  chart.update();
}

window.addEventListener('themechange', () => {
  if (chart) chart.destroy();
  chart = null;
});
