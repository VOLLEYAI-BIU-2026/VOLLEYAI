import pandas as pd
import numpy as np
import joblib

CONTS = ['mean_x', 'mean_y', 'std_x', 'std_y', 'mean_velocity', 'max_velocity', 'std_velocity',
         'mean_acceleration', 'mean_angle_change', 'mean_y_dominance', 'mean_accel_jitter',
         'mean_energy', 'y_range_window', 'mean_vis', 'vis_std', 'is_low_window']

def predict_rallies(rf_path, df_path):
    rf_model = joblib.load(rf_path)
    features_df = pd.read_csv(df_path)
    features_df = features_df.fillna(0)
    predictions = rf_model.predict(features_df[CONTS])
    return predictions

def train_random_forest(rf_path, df_paths, labels_paths, num_est=200, num_min_samples=30):
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import accuracy_score, classification_report

    combined_dfs = []
    for df_p, labels_p in zip(df_paths, labels_paths):
        curr_features = pd.read_csv(df_p)
        curr_labels = pd.read_csv(labels_p)
        curr_features['label'] = curr_labels['label']
        combined_dfs.append(curr_features)

    features_df = pd.concat(combined_dfs, ignore_index=True).fillna(0)
    trn_df, val_df = train_test_split(features_df, test_size=0.25, shuffle=False)
    trn_df, val_df = trn_df.copy(), val_df.copy()

    features_df['label'] = features_df['label'].astype('category')
    class_names = features_df['label'].cat.categories
    dep = 'label'
    trn_df[dep] = pd.Categorical(trn_df[dep], categories=class_names).codes
    val_df[dep] = pd.Categorical(val_df[dep], categories=class_names).codes

    rf = RandomForestClassifier(n_estimators=num_est, min_samples_leaf=num_min_samples, n_jobs=-1)
    rf.fit(trn_df[CONTS], trn_df[dep])

    preds = rf.predict(val_df[CONTS])
    print(f"Accuracy: {accuracy_score(val_df[dep], preds):.4f}")
    print(classification_report(val_df[dep], preds, target_names=[str(c) for c in class_names]))

    joblib.dump(rf, rf_path)
    print(f"Model saved to {rf_path}")
