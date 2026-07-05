import pandas as pd
import numpy as np

def interpolate_small_gaps(series, max_gap):
    isnull = series.isnull()
    gap_ids = (isnull != isnull.shift()).cumsum()
    gap_sizes = gap_ids.map(gap_ids[isnull].value_counts())
    return series.interpolate(method='linear').where(gap_sizes <= max_gap, series)

def extract_features(input_csv, output_csv, window_size=60, start_frame=0, interpolation_size=5):
    df = pd.read_csv(input_csv)
    df = df.sort_values('frame')
    full_range = pd.DataFrame({'frame': range(start_frame, int(df['frame'].max()) + 1)})
    df = pd.merge(full_range, df, on='frame', how='left')

    df['cx'] = interpolate_small_gaps(df['cx'], max_gap=interpolation_size)
    df['cy'] = interpolate_small_gaps(df['cy'], max_gap=interpolation_size)
    df['conf'] = df['conf'].fillna(0)

    df['vx'] = df['cx'].diff().fillna(0)
    df['vy'] = df['cy'].diff().fillna(0)
    df['velocity'] = np.sqrt(df['vx']**2 + df['vy']**2)
    df['velocity'] = df['velocity'].clip(upper=300)
    df['acceleration'] = df['velocity'].diff().fillna(0)
    df['angle'] = np.degrees(np.arctan2(df['vy'], df['vx']))
    df['angle_diff'] = df['angle'].diff().abs() % 360
    df['angle_diff'] = np.minimum(df['angle_diff'], 360 - df['angle_diff']).fillna(0)

    df['y_dominance'] = np.abs(df['vy']) / (np.abs(df['vx']) + 1e-5)
    df['accel_jitter'] = df['acceleration'].diff().abs().fillna(0)
    df['energy'] = df['velocity']**2

    if not df['cy'].dropna().empty:
        floor_threshold = df['cy'].quantile(0.7)
        df['is_low'] = (df['cy'] > floor_threshold).astype(int)
    else:
        df['is_low'] = 0

    rolling = df.rolling(window=window_size, center=True, min_periods=1)
    df['mean_x'] = rolling['cx'].mean()
    df['mean_y'] = rolling['cy'].mean()
    df['std_x'] = rolling['cx'].std().fillna(0)
    df['std_y'] = rolling['cy'].std().fillna(0)
    df['mean_velocity'] = rolling['velocity'].mean()
    df['max_velocity'] = rolling['velocity'].max()
    df['std_velocity'] = rolling['velocity'].std().fillna(0)
    df['mean_acceleration'] = rolling['acceleration'].mean()
    df['mean_angle_change'] = rolling['angle_diff'].mean()
    df['mean_y_dominance'] = rolling['y_dominance'].mean()
    df['mean_accel_jitter'] = rolling['accel_jitter'].mean()
    df['mean_energy'] = rolling['energy'].mean()
    df['y_range_window'] = rolling['cy'].max() - rolling['cy'].min()
    df['mean_vis'] = rolling['conf'].mean()
    df['vis_std'] = rolling['conf'].std().fillna(0)
    df['is_low_window'] = rolling['is_low'].mean()

    df.to_csv(output_csv, index=False)
