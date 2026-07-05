import pandas as pd
import numpy as np

def smooth_predictions(predictions, window_size=5, min_segment_len=60):
    if len(predictions) == 0:
        return predictions

    series = pd.Series(predictions)
    smoothed = series.rolling(window=window_size, center=True).apply(
        lambda x: x.mode().iloc[0] if not x.mode().empty else x.iloc[len(x)//2]
    ).fillna(series)

    smoothed_list = smoothed.tolist()

    changed = True
    while changed:
        changed = False
        i = 0
        while i < len(smoothed_list):
            start = i
            val = smoothed_list[i]
            min_len = min_segment_len * 2 if val == 0 else min_segment_len
            while i < len(smoothed_list) and smoothed_list[i] == val:
                i += 1
            segment_len = i - start
            if segment_len < min_len:
                prev_val = smoothed_list[start - 1] if start > 0 else None
                next_val = smoothed_list[i] if i < len(smoothed_list) else None
                new_val = prev_val if prev_val is not None else next_val
                if new_val is not None and new_val != val:
                    smoothed_list[start:i] = [new_val] * segment_len
                    changed = True

    return smoothed_list

def analyze_rally_stats(predictions, fps=30):
    s = pd.Series(predictions)
    groups = (s != s.shift()).cumsum()
    segments = s.groupby(groups).agg(label='first', frame_count='count')
    segments['duration_sec'] = segments['frame_count'] / fps
    rallies = segments[segments['label'] == 1]['duration_sec']
    downtime = segments[segments['label'] == 0]['duration_sec']
    stats = {
        "Total Rallies": len(rallies),
        "Shortest Rally (s)": float(round(rallies.min(), 2)) if not rallies.empty else 0,
        "Longest Rally (s)": float(round(rallies.max(), 2)) if not rallies.empty else 0,
        "Average Rally (s)": float(round(rallies.mean(), 2)) if not rallies.empty else 0,
        "Shortest Downtime (s)": float(round(downtime.min(), 2)) if not downtime.empty else 0,
        "Total Playtime (s)": float(round(rallies.sum(), 2))
    }
    return stats, segments
