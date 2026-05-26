import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type LineData,
  type Time,
} from 'lightweight-charts';
import { mockChartDataByTimeframe, type ChartTimeframe } from '../../data/mockChartData';
import { useChartHistory, type ChartHistory } from '../../hooks/useChartHistory';
import { rsiLineFromCandles } from '../../utils/rsi';
import type { ChartMode, OverlayKey } from './ChartControls';

type ChartData = ChartHistory & { rsi: LineData<Time>[]; entryDate?: Time };

export function PriceChart({
  symbol,
  timeframe,
  mode,
  overlays,
  entryPrice,
  entryDate,
}: {
  symbol?: string;
  timeframe: ChartTimeframe;
  mode: ChartMode;
  overlays: Record<OverlayKey, boolean>;
  entryPrice?: number;
  // ISO timestamp of the position's entry (first_seen_at). The entry marker
  // renders only when this falls inside the visible candle window.
  entryDate?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rsiHostRef = useRef<HTMLDivElement | null>(null);
  const { history: fetched, isLoading } = useChartHistory(symbol, timeframe);

  const entrySec = useMemo<Time | undefined>(() => {
    if (!entryDate) return undefined;
    const ms = Date.parse(entryDate);
    return Number.isFinite(ms) ? (Math.floor(ms / 1000) as Time) : undefined;
  }, [entryDate]);

  // Assemble the chart bundle once per data/timeframe change. RSI is computed
  // client-side from fetched candle closes (the BE history endpoint doesn't
  // return it); the mock path carries its own decorative RSI.
  const data = useMemo<ChartData>(() => {
    if (fetched) {
      return { ...fetched, rsi: rsiLineFromCandles(fetched.candles), entryDate: entrySec };
    }
    const mock = mockChartDataByTimeframe[timeframe];
    return {
      candles: mock.candles,
      closeLine: mock.closeLine,
      vwap: mock.vwap,
      volume: mock.volume,
      rsi: mock.rsi,
      entryDate: mock.entryDate,
    };
  }, [fetched, timeframe, entrySec]);

  const hasRsi = data.rsi.length > 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const textPrimary = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#f5f5f3';
    const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(255,255,255,0.08)';
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f0f0f';

    const chart = createChart(host, {
      width: host.clientWidth,
      height: 220,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: textPrimary,
      },
      crosshair: { mode: CrosshairMode.Normal },
      grid: {
        vertLines: { color: borderColor },
        horzLines: { color: borderColor },
      },
      handleScale: true,
      handleScroll: true,
      // Tighter margins than the ~20% default so the day's high sits near the
      // top edge instead of floating well below it.
      rightPriceScale: { borderColor, scaleMargins: { top: 0.08, bottom: 0.12 } },
      timeScale: { borderColor },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: 'rgba(99, 153, 34, 0.9)',
      downColor: 'rgba(226, 75, 74, 0.9)',
      borderUpColor: 'rgba(99, 153, 34, 1)',
      borderDownColor: 'rgba(226, 75, 74, 1)',
      wickUpColor: 'rgba(99, 153, 34, 1)',
      wickDownColor: 'rgba(226, 75, 74, 1)',
      visible: mode === 'candle',
    });
    candleSeries.setData(data.candles);

    const lineSeries = chart.addSeries(LineSeries, {
      color: '#4f8ef7',
      lineWidth: 2,
      visible: mode === 'line',
    });
    lineSeries.setData(data.closeLine);

    if (overlays.vwap && data.vwap.length > 0) {
      const vwapSeries = chart.addSeries(LineSeries, {
        color: '#8f68ff',
        lineWidth: 2,
        lineStyle: 2,
      });
      vwapSeries.setData(data.vwap);
    }

    if (overlays.volume && data.volume.length > 0) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        // Bars only — the per-bar last-value tag (e.g. "5.59K") read as a
        // confusing daily-total figure, so suppress the axis label + price line.
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.75, bottom: 0 },
      });
      volumeSeries.setData(data.volume);
    }

    // Avg-cost reference: a prominent labeled price line spanning the chart.
    // The entry-date marker is rendered only when the entry actually falls in
    // the visible window (otherwise it used to pin to the left edge).
    if (entryPrice !== undefined) {
      const activeSeries = mode === 'candle' ? candleSeries : lineSeries;
      activeSeries.createPriceLine({
        price: entryPrice,
        color: '#f5b500',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `Avg $${entryPrice.toFixed(2)}`,
      });

      const firstTime = data.closeLine[0]?.time;
      const lastTime = data.closeLine[data.closeLine.length - 1]?.time;
      const entryT = data.entryDate;
      const inWindow =
        entryT !== undefined &&
        firstTime !== undefined &&
        lastTime !== undefined &&
        (entryT as number) >= (firstTime as number) &&
        (entryT as number) <= (lastTime as number);
      if (inWindow) {
        createSeriesMarkers(activeSeries, [
          {
            time: entryT as Time,
            position: 'aboveBar',
            color: '#f5b500',
            shape: 'arrowDown',
            text: 'Entry',
          },
        ]);
      }
    }

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth });
    });
    resizeObserver.observe(host);

    let rsiChart: ReturnType<typeof createChart> | undefined;
    let rsiResizeObserver: ResizeObserver | undefined;

    if (overlays.rsi && rsiHostRef.current && data.rsi.length > 0) {
      const rsiHost = rsiHostRef.current;
      rsiChart = createChart(rsiHost, {
        width: rsiHost.clientWidth,
        height: 90,
        layout: { background: { type: ColorType.Solid, color: bgColor }, textColor: textPrimary },
        grid: { vertLines: { color: borderColor }, horzLines: { color: borderColor } },
        rightPriceScale: {
          borderColor,
          scaleMargins: { top: 0.05, bottom: 0.05 },
        },
        timeScale: { borderColor, visible: false },
        crosshair: { mode: CrosshairMode.Normal },
        handleScroll: false,
        handleScale: true,
      });
      const rsiSeries = rsiChart.addSeries(LineSeries, { color: '#f5b500', lineWidth: 2 });
      rsiSeries.setData(data.rsi);
      const overboughtLine = rsiChart.addSeries(LineSeries, {
        color: 'rgba(226, 75, 74, 0.5)',
        lineWidth: 1,
        lineStyle: 2,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      overboughtLine.setData(data.rsi.map((point) => ({ time: point.time, value: 70 })));
      const oversoldLine = rsiChart.addSeries(LineSeries, {
        color: 'rgba(99, 153, 34, 0.5)',
        lineWidth: 1,
        lineStyle: 2,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      oversoldLine.setData(data.rsi.map((point) => ({ time: point.time, value: 30 })));
      rsiChart.priceScale('right').applyOptions({ autoScale: false });
      rsiChart.timeScale().fitContent();
      rsiResizeObserver = new ResizeObserver(() => {
        rsiChart?.applyOptions({ width: rsiHost.clientWidth });
      });
      rsiResizeObserver.observe(rsiHost);
    }

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      rsiResizeObserver?.disconnect();
      rsiChart?.remove();
    };
  }, [mode, overlays.rsi, overlays.volume, overlays.vwap, data, entryPrice]);

  return (
    <div className="price-chart-wrap">
      <div ref={hostRef} className="price-chart-main">
        {isLoading && !fetched && <div className="price-chart-loading">Loading chart…</div>}
      </div>
      {overlays.rsi && hasRsi && (
        <div className="price-chart-rsi-wrap">
          <div className="price-chart-rsi-band overbought" />
          <div className="price-chart-rsi-band oversold" />
          <div ref={rsiHostRef} className="price-chart-rsi" />
        </div>
      )}
    </div>
  );
}
