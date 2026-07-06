# src/rally_predictor/predictions_handler.py

import pandas as pd
import numpy as np

def smooth_predictions(predictions, window_size=90, min_segment_len=60):
    """
    Cleans up classification jitter by removing impossible short-duration segments.

    This works in two stages:
    1. A temporal 'mode' filter to remove 1-2 frame spikes (flicker).
    2. A segment-merging pass that absorbs any state (Rally or Downtime) 
       that lasts shorter than the defined minimum threshold.

    Args:
        predictions (list or np.array): Raw 0/1 predictions from the model.
        window_size (int): The size of the rolling window for the initial mode filter.
        min_segment_len (int): The minimum number of frames a state must last 
            (e.g., 60 frames = 2 seconds at 30fps) to be considered valid.

    Returns:
        list: A cleaned and smoothed list of state predictions.
    """
    if len(predictions) == 0:
        return predictions

    # 1. APPLY ROLLING MODE FILTER
    # Replaces each value with the most frequent value in its immediate neighborhood.
    # This effectively acts as a 'denoiser' for high-frequency classification swaps.
    series = pd.Series(predictions)
    smoothed = series.rolling(window=window_size, center=True).apply(
        lambda x: x.mode().iloc[0] if not x.mode().empty else x.iloc[len(x)//2]
    ).fillna(series) 
    
    smoothed_list = smoothed.tolist()

    # 2. MERGE SMALL SEGMENTS
    # Iteratively removes 'micro-segments' that are shorter than min_segment_len.
    # If a rally lasts only 0.5 seconds, it's likely a tracking error and is 
    # absorbed into the surrounding downtime.
    changed = True
    while changed:
        changed = False
        i = 0
        while i < len(smoothed_list):
            start = i
            val = smoothed_list[i]
            if val == 0:
                min_len = min_segment_len * 2  # Longer for downtime
            else:
                min_len = min_segment_len
            
            # Identify the boundaries of the current contiguous segment
            while i < len(smoothed_list) and smoothed_list[i] == val:
                i += 1
            segment_len = i - start
            
            # If the segment is shorter than our threshold, flip its value
            if segment_len < min_len:
                prev_val = smoothed_list[start - 1] if start > 0 else None
                next_val = smoothed_list[i] if i < len(smoothed_list) else None
                
                # Assign the value of the neighboring segment
                new_val = prev_val if prev_val is not None else next_val
                
                if new_val is not None and new_val != val:
                    smoothed_list[start:i] = [new_val] * segment_len
                    changed = True # Re-check the list as merging can trigger new merges
                    
    return smoothed_list

def analyze_rally_stats(predictions, fps=30):
    """
    Aggregates frame-by-frame predictions into meaningful volleyball match statistics.

    This function segments the timeline into contiguous blocks of 'Rally' vs 'Downtime'
    and calculates temporal metrics like average rally length and total play percentage.

    Args:
        predictions (list or np.array): Smoothed 0/1 predictions.
        fps (int): Frames per second of the video (used for time conversion).

    Returns:
        tuple: (stats_dict, segments_df)
            - stats_dict: A dictionary containing summary KPIs.
            - segments_df: A DataFrame detailing every individual segment and its duration.
    """
    s = pd.Series(predictions)
    
    # 1. SEGMENTATION LOGIC
    # Identify groups of consecutive identical values using the cumsum pattern.
    # This allows us to group by 'event' rather than just by 'label'.
    groups = (s != s.shift()).cumsum()
    
    # Create a DataFrame where each row represents one 'event' (a rally or a break)
    segments = s.groupby(groups).agg(
        label='first',
        frame_count='count'
    )
    
    # Convert frame counts into human-readable seconds
    segments['duration_sec'] = segments['frame_count'] / fps
    
    # 2. KPI CALCULATION
    # Extract only the segments where the label corresponds to a Rally (1)
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
