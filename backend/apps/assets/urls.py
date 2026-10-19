from django.urls import path
from rest_framework.routers import SimpleRouter

from .audio_stock import (
    AudioStockImportView,
    AudioStockInfoView,
    AudioStockPreviewView,
    AudioStockSearchView,
)
from .stock import StockImportView, StockProvidersView, StockSearchView
from .video_stock import (
    VideoStockImportView,
    VideoStockInfoView,
    VideoStockPreviewView,
    VideoStockSearchView,
)
from .views import AssetViewSet

router = SimpleRouter()
router.register("assets", AssetViewSet, basename="asset")

urlpatterns = [
    *router.urls,
    path("stock/photos/", StockSearchView.as_view(), name="stock-photos"),
    path("stock/providers/", StockProvidersView.as_view(), name="stock-providers"),
    path("stock/photos/import/", StockImportView.as_view(), name="stock-photo-import"),
    path("stock/audio/", AudioStockSearchView.as_view(), name="stock-audio"),
    path("stock/audio/info/", AudioStockInfoView.as_view(), name="stock-audio-info"),
    path("stock/audio/import/", AudioStockImportView.as_view(), name="stock-audio-import"),
    path("stock/audio/<str:sound_id>/preview/", AudioStockPreviewView.as_view(), name="stock-audio-preview"),
    path("stock/videos/", VideoStockSearchView.as_view(), name="stock-videos"),
    path("stock/videos/info/", VideoStockInfoView.as_view(), name="stock-video-info"),
    path("stock/videos/import/", VideoStockImportView.as_view(), name="stock-video-import"),
    path(
        "stock/videos/<str:provider_name>/<str:video_id>/preview/",
        VideoStockPreviewView.as_view(),
        name="stock-video-preview",
    ),
]
