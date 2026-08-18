# PWA更新ガイド

UI10のフロントエンドとService Workerは、このバックエンドリポジトリではなく[`StepBy`](https://github.com/kumakero-otama/StepBy)リポジトリで管理し、GitHub Pagesから公開します。

この`barrierfree-map`リポジトリの`public/`は、クラウド管理画面、OpenAPI、および旧ローカル画面との互換用です。UI10のPWAキャッシュを変更するときは`StepBy/UI10/sw.js`を更新してください。

## UI10更新時

1. `StepBy`の`dev`ブランチで変更
2. フロントエンドテストを実行
3. `UI10/sw.js`の`CACHE_VERSION`を更新
4. `dev`へpush
5. 確認後に`main`へ昇格しGitHub Pagesへ公開
6. PWAを再起動し、新しいService Workerが有効になったことを確認

APIレスポンスはService Workerへ保存せず、認証情報や記録送信結果に古いキャッシュを使用しません。

バックエンドだけを変更した場合は、UI10のキャッシュ更新は不要です。ただしAPI仕様やフロントの呼出し方が変わる場合は、両リポジトリを同時に更新してください。
