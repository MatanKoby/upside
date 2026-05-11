import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts';
import { mockChartDataByTimeframe, type ChartTimeframe } from '../../data/mockChartData';
import type { ChartMode, OverlayKey } from './ChartControls';

export function PriceChart({
  timeframe,
  mode,
  overlays,
}: {
  timeframe: ChartTimeframe;
  mode: ChartMode;
  overlays: Record<OverlayKey, boolean>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rsiHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }
    const data = mockChartDataByTimeframe[timeframe];
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
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      grid: {
        vertLines: { color: borderColor },
        horzLines: { color: borderColor },
      },
      handleScale: true,
      handleScroll: true,
      rightPriceScale: {
        borderColor,
      },
      timeScale: {
        borderColor,
      },
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

    if (overlays.vwap) {
      const vwapSeries = chart.addSeries(LineSeries, {
        color: '#8f68ff',
        lineWidth: 2,
        lineStyle: 2,
      });
      vwapSeries.setData(data.vwap);
    }

    if (overlays.volume) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: {
          top: 0.75,
          bottom: 0,
        },
      });
      volumeSeries.setData(data.volume);
    }

    const markerTarget = mode === 'candle' ? candleSeries : lineSeries;
    createSeriesMarkers(markerTarget, [
      {
        time: data.entryDate,
        position: 'aboveBar',
        color: '#f5b500',
        shape: 'arrowDown',
        text: 'Entry',
      },
    ]);

    const firstTime = data.closeLine[0]?.time;
    const lastTime = data.closeLine[data.closeLine.length - 1]?.time;
    if (firstTime && lastTime) {
      const entryLine = chart.addSeries(LineSeries, {
        color: 'rgba(245, 181, 0, 0.65)',
        lineStyle: 2,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      entryLine.setData([
        { time: firstTime, value: data.entryPrice },
        { time: lastTime, value: data.entryPrice },
      ]);
    }

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth });
    });
    resizeObserver.observe(host);

    let rsiChart: ReturnType<typeof createChart> | undefined;
    let rsiResizeObserver: ResizeObserver | undefined;

    if (overlays.rsi && rsiHostRef.current) {
      const rsiHost = rsiHostRef.current;
      rsiChart = createChart(rsiHost, {
        width: rsiHost.clientWidth,
        height: 90,
        layout: {
          background: { type: ColorType.Solid, color: bgColor },
          textColor: textPrimary,
        },
        grid: {
          vertLines: { color: borderColor },
          horzLines: { color: borderColor },
        },
        rightPriceScale: {
          borderColor,
          scaleMargins: {
            top: 0.05,
            bottom: 0.05,
          },
        },
        timeScale: {
          borderColor,
          visible: false,
        },
        crosshair: {
          mode: CrosshairMode.Normal,
        },
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
  }, [mode, overlays.rsi, overlays.volume, overlays.vwap, timeframe]);

  return (
    <div className="price-chart-wrap">
      <div ref={hostRef} className="price-chart-main" />
      {overlays.rsi && (
        <div className="price-chart-rsi-wrap">
          <div className="price-chart-rsi-band overbought" />
          <div className="price-chart-rsi-band oversold" />
          <div ref={rsiHostRef} className="price-chart-rsi" />
        </div>
      )}
    </div>
  );
}
